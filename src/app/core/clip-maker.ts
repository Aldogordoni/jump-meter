/**
 * Build a short MP4 of the jump: from just before the first marked moment to just
 * after landing, played back at 30 fps (so 240 fps footage plays 8× slowed), with a
 * short pause and a label on each marked key frame and the result as a caption.
 *
 * Uses WebCodecs VideoEncoder + mp4-muxer; falls back to MediaRecorder.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { openFrameSource, type FrameSource } from './frame-source';

export interface ClipMark {
  frame: number;
  label: string;
}

export interface ClipOptions {
  source: FrameSource;
  /** Real capture rate, used for the padding before/after. */
  realFps: number;
  marks: ClipMark[];
  caption: string;
  subcaption: string;
  onProgress?: (fraction: number) => void;
  quality?: ClipQuality;
}

const OUT_FPS = 30;
const MAX_SIDE = 1080;
/** Clip size: high is 1080p at 8 Mbps; standard is 720p at 3.5 Mbps (about a third of the size). */
export type ClipQuality = 'high' | 'standard';
const QUALITY: Record<ClipQuality, { side: number; bitrate: number }> = {
  high: { side: 1080, bitrate: 8_000_000 },
  standard: { side: 720, bitrate: 3_500_000 },
};
const HOLD_FRAMES = 18; // 0.6 s pause on each key frame
const MAX_SOURCE_FRAMES = 420;

export async function makeClip(opts: ClipOptions): Promise<{ video: Blob; poster: Blob; mime: string }> {
  const { source, realFps, marks } = opts;
  const q = QUALITY[opts.quality ?? 'high'];
  const sorted = [...marks].sort((a, b) => a.frame - b.frame);
  const pad = Math.round(realFps * 0.3);
  const first = Math.max(0, sorted[0].frame - pad);
  const last = Math.min(source.frameCount - 1, sorted[sorted.length - 1].frame + pad);
  const step = Math.max(1, Math.ceil((last - first + 1) / MAX_SOURCE_FRAMES));
  const frames: number[] = [];
  for (let f = first; f <= last; f += step) frames.push(f);
  for (const m of sorted) if (!frames.includes(m.frame)) frames.push(m.frame);
  frames.sort((a, b) => a - b);

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, q.side / Math.max(source.width, source.height));
  // Encoders want even dimensions.
  canvas.width = Math.max(2, Math.round((source.width * scale) / 2) * 2);
  canvas.height = Math.max(2, Math.round((source.height * scale) / 2) * 2);
  const ctx = canvas.getContext('2d')!;

  const encoder = await createEncoder(canvas, q.bitrate);
  let poster: Blob | null = null;
  let activeLabel = '';
  let outIndex = 0;
  const total = frames.length + sorted.length * HOLD_FRAMES;

  await source.scan(frames, q.side, async (i, img) => {
    const mark = sorted.find((m) => m.frame === i);
    if (mark) activeLabel = mark.label;
    drawFrame(ctx, img, canvas, activeLabel, opts.caption, opts.subcaption, !!mark);
    const repeats = mark ? HOLD_FRAMES : 1;
    for (let r = 0; r < repeats; r++) {
      await encoder.add(outIndex++);
      opts.onProgress?.(outIndex / total);
    }
    if (mark && !poster && /take-off/i.test(mark.label)) poster = await toJpeg(canvas);
  });
  poster ??= await toJpeg(canvas);
  const video = await encoder.finish();
  return { video, poster, mime: video.type };
}

/**
 * Cut a saved clip down to [fromSec, toSec] (clip time). Re-encodes the frames as they are,
 * captions included. Returns null when nothing would change.
 */
export async function trimClip(
  video: Blob,
  mime: string,
  fromSec: number,
  toSec: number,
  onProgress?: (f: number) => void,
): Promise<{ video: Blob; poster: Blob; mime: string } | null> {
  const ext = mime.includes('webm') ? 'webm' : 'mp4';
  const source = await openFrameSource(new File([video], `clip.${ext}`, { type: mime.split(';')[0] }), OUT_FPS);
  try {
    const t0 = source.timeAt(0);
    const frames: number[] = [];
    for (let i = 0; i < source.frameCount; i++) {
      const t = source.timeAt(i) - t0;
      if (t >= fromSec - 1e-3 && t <= toSec + 1e-3) frames.push(i);
    }
    if (frames.length < 2 || frames.length >= source.frameCount) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
    canvas.width = Math.max(2, Math.round((source.width * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((source.height * scale) / 2) * 2);
    const ctx = canvas.getContext('2d')!;
    const encoder = await createEncoder(canvas, 8_000_000);
    let poster: Blob | null = null;
    let n = 0;
    await source.scan(frames, MAX_SIDE, async (_i, img) => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (!poster) poster = await toJpeg(canvas);
      await encoder.add(n++);
      onProgress?.(n / frames.length);
    });
    const out = await encoder.finish();
    return { video: out, poster: poster ?? (await toJpeg(canvas)), mime: out.type };
  } finally {
    source.dispose();
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  img: ImageBitmap,
  canvas: HTMLCanvasElement,
  label: string,
  caption: string,
  subcaption: string,
  highlight: boolean,
) {
  const { width: w, height: h } = canvas;
  ctx.drawImage(img, 0, 0, w, h);
  const u = Math.max(w, h) / 100; // layout unit

  // Key-frame label, top left.
  if (label) {
    ctx.font = `700 ${3.4 * u}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = highlight ? '#d7263d' : 'rgba(23,32,51,0.75)';
    roundRect(ctx, 2 * u, 2 * u, tw + 3 * u, 5.2 * u, 2.6 * u);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 3.5 * u, 4.7 * u);
  }

  // Result caption, bottom.
  const barH = 9 * u;
  ctx.fillStyle = 'rgba(23,32,51,0.82)';
  ctx.fillRect(0, h - barH, w, barH);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${5 * u}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  ctx.fillText(caption, 2.5 * u, h - barH / 2);
  const cw = ctx.measureText(caption).width;
  ctx.font = `500 ${2.6 * u}px "Barlow", system-ui, sans-serif`;
  ctx.fillStyle = '#c9d2dd';
  ctx.fillText(subcaption, 2.5 * u + cw + 2.5 * u, h - barH / 2);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('poster failed'))), 'image/jpeg', 0.8),
  );
}

interface Encoder {
  add(index: number): Promise<void>;
  finish(): Promise<Blob>;
}

async function createEncoder(canvas: HTMLCanvasElement, bitrate: number): Promise<Encoder> {
  if (typeof VideoEncoder !== 'undefined') {
    // H.264 plays everywhere (Photos, WhatsApp…); VP9 is a fast fallback for browsers without an H.264 encoder.
    const options: [string, 'avc' | 'vp9'][] = [
      ['avc1.640028', 'avc'],
      ['avc1.4d0028', 'avc'],
      ['avc1.42001f', 'avc'],
      ['vp09.00.31.08', 'vp9'],
    ];
    for (const [codec, kind] of options) {
      const config: VideoEncoderConfig = {
        codec,
        width: canvas.width,
        height: canvas.height,
        bitrate,
        framerate: OUT_FPS,
        ...(kind === 'avc' ? { avc: { format: 'avc' as const } } : {}),
      };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return webCodecsEncoder(canvas, config, kind);
      } catch {
        /* try next */
      }
    }
  }
  return mediaRecorderEncoder(canvas, bitrate);
}

function webCodecsEncoder(canvas: HTMLCanvasElement, config: VideoEncoderConfig, kind: 'avc' | 'vp9'): Encoder {
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: kind, width: canvas.width, height: canvas.height, frameRate: OUT_FPS },
    fastStart: 'in-memory',
  });
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(config);
  const frameUs = 1_000_000 / OUT_FPS;
  return {
    async add(index) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(index * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: index % 60 === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    },
    async finish() {
      await encoder.flush();
      encoder.close();
      if (failure) throw failure;
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
  };
}

/** Fallback: record the canvas in real time while we paint frames at 30 fps. */
function mediaRecorderEncoder(canvas: HTMLCanvasElement, bitrate: number): Encoder {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    throw new Error('This browser cannot create video files.');
  }
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  let last = performance.now();
  return {
    async add() {
      track.requestFrame?.();
      const wait = 1000 / OUT_FPS - (performance.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = performance.now();
    },
    finish() {
      return new Promise((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }));
        rec.stop();
      });
    },
  };
}
