/**
 * Exact, frame-indexed access to a video file.
 *
 * Primary path: WebCodecs. mp4box demuxes the MP4/MOV, we decode the actual
 * coded frames, and frame N is always the Nth picture in the file. No seeking
 * guesswork, and pose analysis can stream frames in one sequential pass.
 *
 * Fallback: an <video> element with seek-and-wait (older browsers).
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Movie, type Sample } from 'mp4box';

export interface FrameSource {
  readonly kind: 'webcodecs' | 'video';
  readonly frameCount: number;
  /** Average container frame rate (frames per second of file time). */
  readonly fps: number;
  /** Upright display size. */
  readonly width: number;
  readonly height: number;
  /**
   * File time (seconds) of a frame, interpolated for fractional indices. Uses the real
   * timestamps, so uneven frame timing (live recordings) is handled correctly.
   */
  timeAt(index: number): number;
  /** Draw frame `index` onto the canvas. Resolves false if a newer request superseded it. */
  show(index: number, canvas: HTMLCanvasElement): Promise<boolean>;
  /**
   * Visit the requested frames in order, as upright bitmaps no larger than
   * `maxSide`. The bitmap is closed after `visit` returns.
   */
  scan(
    indices: number[],
    maxSide: number,
    visit: (index: number, image: ImageBitmap) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  dispose(): void;
}

const DISPLAY_MAX_SIDE = 1280;
/** Memory budget for decoded frames kept for instant stepping. */
const CACHE_BYTES = 280 * 1024 * 1024;

export async function openFrameSource(file: File, hintFps: number | null): Promise<FrameSource> {
  if (typeof VideoDecoder !== 'undefined') {
    try {
      const src = await WebCodecsSource.open(file);
      if (src) return src;
    } catch (e) {
      console.warn('WebCodecs path unavailable, falling back to <video>', e);
    }
  }
  return VideoElementSource.open(file, hintFps);
}

// ---------------------------------------------------------------------------
// WebCodecs
// ---------------------------------------------------------------------------

interface FrameInfo {
  decodeIdx: number;
  timestampUs: number;
}

class WebCodecsSource implements FrameSource {
  readonly kind = 'webcodecs' as const;
  readonly frameCount: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;

  /** Display order → decode info. */
  private readonly frames: FrameInfo[];
  /** Decode order → display index. */
  private readonly displayOfDecode: number[];
  private readonly tsToDisplay = new Map<number, number>();
  private readonly cache = new Map<number, ImageBitmap>();
  private chain: Promise<unknown> = Promise.resolve();
  private latestShow = 0;
  private disposed = false;

  private constructor(
    private readonly file: File,
    private readonly samples: Sample[],
    private readonly config: VideoDecoderConfig,
    private readonly rotation: number,
    codedW: number,
    codedH: number,
  ) {
    const order = samples.map((_, i) => i).sort((a, b) => samples[a].cts - samples[b].cts);
    this.frames = order.map((d) => ({ decodeIdx: d, timestampUs: usOf(samples[d]) }));
    this.displayOfDecode = new Array(samples.length);
    order.forEach((d, disp) => {
      this.displayOfDecode[d] = disp;
      this.tsToDisplay.set(usOf(samples[d]), disp);
    });
    this.frameCount = samples.length;
    const first = samples[order[0]];
    const last = samples[order[order.length - 1]];
    const span = (last.cts + last.duration - first.cts) / first.timescale;
    this.fps = span > 0 ? Math.round((samples.length / span) * 100) / 100 : 30;
    const swap = rotation === 90 || rotation === 270;
    this.width = swap ? codedH : codedW;
    this.height = swap ? codedW : codedH;
  }

  static async open(file: File): Promise<WebCodecsSource | null> {
    const { mp4, info } = await parseMovie(file);
    const track = info.videoTracks[0];
    if (!track) return null;

    const trak = mp4.getTrackById(track.id);
    let description: Uint8Array | undefined;
    for (const entry of (trak as any).mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
        box.write(stream);
        description = new Uint8Array(stream.buffer, 8); // drop the box header
        break;
      }
    }
    const codedWidth = track.video?.width ?? 0;
    const codedHeight = track.video?.height ?? 0;
    const config: VideoDecoderConfig = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedWidth,
      codedHeight,
      description,
      optimizeForLatency: true,
    };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      // Try software decoding before giving up.
      const sw = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' });
      if (!sw.supported) return null;
      config.hardwareAcceleration = 'prefer-software';
    }

    const samples = mp4.getTrackSamplesInfo(track.id);
    if (!samples.length) return null;
    return new WebCodecsSource(file, samples, config, rotationOf(track.matrix), codedWidth, codedHeight);
  }

  timeAt(index: number): number {
    const n = this.frames.length;
    if (!n) return 0;
    const t0 = this.frames[0].timestampUs;
    const at = (i: number) => (this.frames[Math.min(n - 1, Math.max(0, i))].timestampUs - t0) / 1e6;
    if (index <= 0) return at(0) + index * (n > 1 ? at(1) - at(0) : 1 / this.fps);
    if (index >= n - 1) return at(n - 1) + (index - (n - 1)) * (n > 1 ? at(n - 1) - at(n - 2) : 1 / this.fps);
    const i = Math.floor(index);
    return at(i) + (index - i) * (at(i + 1) - at(i));
  }

  show(index: number, canvas: HTMLCanvasElement): Promise<boolean> {
    const ticket = ++this.latestShow;
    const run = async () => {
      if (ticket !== this.latestShow || this.disposed) return false;
      let bmp = this.cache.get(index);
      if (!bmp) {
        await this.fillCache(index);
        bmp = this.cache.get(index);
      }
      if (!bmp || ticket !== this.latestShow) return false;
      draw(canvas, bmp);
      return true;
    };
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  /** Decode the GOP around `index` and cache nearby frames for instant stepping. */
  private async fillCache(index: number) {
    const keep = (d: number) => Math.abs(d - index) <= 60;
    const targets = this.framesForGop(index).filter(keep);
    await this.decodeFrames(targets, DISPLAY_MAX_SIDE, (i, bmp) => {
      this.cache.set(i, bmp);
      return true; // keep the bitmap
    });
    // Evict far-away frames to stay within the memory budget.
    const any = this.cache.values().next().value as ImageBitmap | undefined;
    const perFrame = any ? any.width * any.height * 4 : 1;
    const maxFrames = Math.max(30, Math.floor(CACHE_BYTES / perFrame));
    if (this.cache.size > maxFrames) {
      const far = [...this.cache.keys()].sort((a, b) => Math.abs(b - index) - Math.abs(a - index));
      for (const k of far.slice(0, this.cache.size - Math.floor(maxFrames * 0.75))) {
        this.cache.get(k)?.close();
        this.cache.delete(k);
      }
    }
  }

  /** All display indices whose decode lies in the same GOP as `index`. */
  private framesForGop(index: number): number[] {
    const d = this.frames[index].decodeIdx;
    let k = d;
    while (k > 0 && !this.samples[k].is_sync) k--;
    let e = d + 1;
    while (e < this.samples.length && !this.samples[e].is_sync) e++;
    const out: number[] = [];
    for (let i = k; i < e; i++) out.push(this.displayOfDecode[i]);
    return out.sort((a, b) => a - b);
  }

  async scan(
    indices: number[],
    maxSide: number,
    visit: (index: number, image: ImageBitmap) => void | Promise<void>,
    signal?: AbortSignal,
  ) {
    const p = this.chain.then(() =>
      this.decodeFrames(
        [...new Set(indices)].sort((a, b) => a - b),
        maxSide,
        async (i, bmp) => {
          await visit(i, bmp);
          return false;
        },
        signal,
      ),
    );
    this.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * Decode just enough of the file to produce the wanted display frames.
   * `onFrame` returns true to keep the bitmap (otherwise it's closed).
   */
  private async decodeFrames(
    wanted: number[],
    maxSide: number,
    onFrame: (index: number, bmp: ImageBitmap) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ) {
    if (!wanted.length) return;
    const want = new Set(wanted);

    // Decode ranges: from the keyframe before each wanted frame to the end of its GOP.
    const decodeSet = new Set<number>();
    for (const disp of wanted) {
      const d = this.frames[disp].decodeIdx;
      let k = d;
      while (k > 0 && !this.samples[k].is_sync) k--;
      if (decodeSet.has(k)) continue;
      let e = k + 1;
      while (e < this.samples.length && !this.samples[e].is_sync) e++;
      for (let i = k; i < e; i++) decodeSet.add(i);
    }
    const decodeList = [...decodeSet].sort((a, b) => a - b);

    const pending: VideoFrame[] = [];
    let failure: unknown = null;
    const decoder = new VideoDecoder({
      output: (f) => pending.push(f),
      error: (e) => (failure = e),
    });
    decoder.configure(this.config);

    const drain = async () => {
      while (pending.length) {
        const frame = pending.shift()!;
        const disp = this.tsToDisplay.get(frame.timestamp) ?? nearest(this.tsToDisplay, frame.timestamp);
        try {
          if (disp !== undefined && want.has(disp) && !this.disposed) {
            const bmp = await upright(frame, this.rotation, maxSide);
            frame.close();
            const keep = await onFrame(disp, bmp);
            if (!keep) bmp.close();
          } else {
            frame.close();
          }
        } catch (e) {
          frame.close();
          throw e;
        }
      }
    };

    try {
      let prev = -2;
      for (const d of decodeList) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (failure) throw failure;
        if (d !== prev + 1 && prev >= 0) {
          // Jumping to a new GOP: finish the previous one first.
          await decoder.flush();
          await drain();
        }
        prev = d;
        const s = this.samples[d];
        const data = new Uint8Array(await this.file.slice(s.offset, s.offset + s.size).arrayBuffer());
        decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: usOf(s),
            duration: Math.round((s.duration * 1e6) / s.timescale),
            data,
          }),
        );
        while (decoder.decodeQueueSize > 6 || pending.length > 3) {
          await drain();
          if (decoder.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
          if (failure) throw failure;
        }
        await drain();
      }
      await decoder.flush();
      await drain();
      if (failure) throw failure;
    } finally {
      pending.forEach((f) => f.close());
      if (decoder.state !== 'closed') decoder.close();
    }
  }

  dispose() {
    this.disposed = true;
    this.cache.forEach((b) => b.close());
    this.cache.clear();
  }
}

async function parseMovie(file: File): Promise<{ mp4: ISOFile; info: Movie }> {
  const mp4 = createFile(false);
  let info: Movie | null = null;
  let error: string | null = null;
  mp4.onReady = (i) => (info = i);
  mp4.onError = (_m, msg) => (error = msg);

  const CHUNK = 2 * 1024 * 1024;
  let pos = 0;
  // Fragmented MP4 (what in-browser recording produces) keeps its samples in moof boxes
  // after the moov, so read the whole file in that case.
  const done = () => !!info && !(info as Movie).isFragmented;
  while (!done() && !error && pos < file.size) {
    const buf = MP4BoxBuffer.fromArrayBuffer(await file.slice(pos, pos + CHUNK).arrayBuffer(), pos);
    const next = mp4.appendBuffer(buf, pos + CHUNK >= file.size);
    pos = next > pos ? next : pos + CHUNK;
  }
  mp4.flush();
  if (!info) throw new Error(error ?? 'Not an MP4/MOV file');
  return { mp4, info };
}

function usOf(s: Sample) {
  return Math.round((s.cts * 1e6) / s.timescale);
}

function nearest(map: Map<number, number>, ts: number): number | undefined {
  let best: number | undefined;
  let bestD = Infinity;
  for (const [k, v] of map) {
    const d = Math.abs(k - ts);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return bestD < 2000 ? best : undefined;
}

function rotationOf(m: ArrayLike<number> | undefined): number {
  if (!m) return 0;
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

let scratch: HTMLCanvasElement | null = null;

async function upright(source: CanvasImageSource & { displayWidth?: number; displayHeight?: number; videoWidth?: number; videoHeight?: number }, rotation: number, maxSide: number): Promise<ImageBitmap> {
  const sw = source.displayWidth ?? source.videoWidth ?? (source as HTMLCanvasElement).width;
  const sh = source.displayHeight ?? source.videoHeight ?? (source as HTMLCanvasElement).height;
  const swap = rotation === 90 || rotation === 270;
  const uw = swap ? sh : sw;
  const uh = swap ? sw : sh;
  const scale = Math.min(1, maxSide / Math.max(uw, uh));
  const w = Math.round(uw * scale);
  const h = Math.round(uh * scale);

  scratch ??= document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d')!;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const dw = (swap ? h : w);
  const dh = (swap ? w : h);
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  return createImageBitmap(scratch);
}

function draw(canvas: HTMLCanvasElement, bmp: ImageBitmap) {
  if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas.width = bmp.width;
    canvas.height = bmp.height;
  }
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
}

// ---------------------------------------------------------------------------
// <video> fallback
// ---------------------------------------------------------------------------

class VideoElementSource implements FrameSource {
  readonly kind = 'video' as const;
  private chain: Promise<unknown> = Promise.resolve();
  private latestShow = 0;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly url: string,
    readonly fps: number,
    readonly frameCount: number,
  ) {}

  timeAt(index: number): number {
    return index / this.fps;
  }

  get width() {
    return this.video.videoWidth;
  }
  get height() {
    return this.video.videoHeight;
  }

  static async open(file: File, hintFps: number | null): Promise<VideoElementSource> {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("This browser can't play that video."));
    });
    // iOS Safari won't paint seeked frames until the video has played once.
    try {
      await video.play();
      video.pause();
    } catch {
      /* autoplay refused – seeking still works on most browsers */
    }
    const fps = hintFps ?? 30;
    return new VideoElementSource(video, url, fps, Math.max(1, Math.floor(video.duration * fps)));
  }

  private seek(index: number): Promise<void> {
    const t = Math.min((index + 0.5) / this.fps, Math.max(0, this.video.duration - 0.001));
    return new Promise((resolve) => {
      const v = this.video;
      const timer = setTimeout(done, 800);
      function done() {
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        resolve();
      }
      function onSeeked() {
        requestAnimationFrame(() => done());
      }
      v.addEventListener('seeked', onSeeked);
      v.currentTime = t;
    });
  }

  show(index: number, canvas: HTMLCanvasElement): Promise<boolean> {
    const ticket = ++this.latestShow;
    const run = async () => {
      if (ticket !== this.latestShow) return false;
      await this.seek(index);
      if (ticket !== this.latestShow) return false;
      const bmp = await upright(this.video, 0, DISPLAY_MAX_SIDE);
      draw(canvas, bmp);
      bmp.close();
      return true;
    };
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  async scan(
    indices: number[],
    maxSide: number,
    visit: (index: number, image: ImageBitmap) => void | Promise<void>,
    signal?: AbortSignal,
  ) {
    for (const i of [...new Set(indices)].sort((a, b) => a - b)) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await this.seek(i);
      const bmp = await upright(this.video, 0, maxSide);
      try {
        await visit(i, bmp);
      } finally {
        bmp.close();
      }
    }
  }

  dispose() {
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
