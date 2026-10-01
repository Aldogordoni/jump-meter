/**
 * Minimal MP4 / QuickTime reader that pulls out what we need to time a jump:
 *  - the frame rate of the video track as stored in the file (container fps)
 *  - the real capture frame rate, when the phone recorded it as metadata
 *    (Android writes `com.android.capture.fps` for slow-motion clips)
 *
 * Only the `moov` box is read, so even large files are cheap to inspect.
 */

export interface VideoInfo {
  /** Frames per second as stored in the file (what the frame stepper uses). */
  containerFps: number | null;
  /** Real-world capture rate if the file says so (slow-mo clips), else null. */
  captureFps: number | null;
  /** Number of frames in the video track. */
  frameCount: number | null;
  /** Duration of the video track in seconds. */
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

const EMPTY: VideoInfo = {
  containerFps: null,
  captureFps: null,
  frameCount: null,
  durationSec: null,
  width: null,
  height: null,
};

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts']);

interface Box {
  type: string;
  start: number; // offset of payload within the view
  end: number; // offset of end of box within the view
}

function readType(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function* children(view: DataView, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = readType(view, pos + 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function findChild(view: DataView, parent: Box, type: string): Box | undefined {
  for (const b of children(view, parent.start, parent.end)) if (b.type === type) return b;
  return undefined;
}

/** Locate the top-level `moov` box without reading the whole file. */
async function readMoov(file: Blob): Promise<DataView | null> {
  let pos = 0;
  while (pos + 8 <= file.size) {
    const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = readType(head, 4);
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (type === 'moov') {
      return new DataView(await file.slice(pos, pos + size).arrayBuffer());
    }
    pos += size;
  }
  return null;
}

export async function readVideoInfo(file: Blob): Promise<VideoInfo> {
  try {
    const view = await readMoov(file);
    if (!view) return { ...EMPTY };
    const moov: Box = { type: 'moov', start: 8, end: view.byteLength };
    const info: VideoInfo = { ...EMPTY };

    for (const trak of children(view, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      const mdia = findChild(view, trak, 'mdia');
      if (!mdia) continue;
      const hdlr = findChild(view, mdia, 'hdlr');
      if (!hdlr || readType(view, hdlr.start + 8) !== 'vide') continue;

      const tkhd = findChild(view, trak, 'tkhd');
      if (tkhd) {
        const version = view.getUint8(tkhd.start);
        const wOff = tkhd.start + (version === 1 ? 88 : 76);
        info.width = Math.round(view.getUint32(wOff) / 65536);
        info.height = Math.round(view.getUint32(wOff + 4) / 65536);
      }

      const mdhd = findChild(view, mdia, 'mdhd');
      let timescale = 0;
      let duration = 0;
      if (mdhd) {
        const version = view.getUint8(mdhd.start);
        if (version === 1) {
          timescale = view.getUint32(mdhd.start + 20);
          duration = Number(view.getBigUint64(mdhd.start + 24));
        } else {
          timescale = view.getUint32(mdhd.start + 12);
          duration = view.getUint32(mdhd.start + 16);
        }
        if (timescale) info.durationSec = duration / timescale;
      }

      const stts = findChild(
        view,
        findChild(view, findChild(view, mdia, 'minf') ?? mdia, 'stbl') ?? mdia,
        'stts',
      );
      if (stts && timescale) {
        const entries = view.getUint32(stts.start + 4);
        let total = 0;
        let bestDelta = 0;
        let bestCount = 0;
        for (let i = 0; i < entries; i++) {
          const count = view.getUint32(stts.start + 8 + i * 8);
          const delta = view.getUint32(stts.start + 12 + i * 8);
          total += count;
          if (count > bestCount && delta > 0) {
            bestCount = count;
            bestDelta = delta;
          }
        }
        info.frameCount = total;
        // The most common frame duration is robust against the odd long first/last frame.
        if (bestDelta) info.containerFps = round2(timescale / bestDelta);
        else if (info.durationSec) info.containerFps = round2(total / info.durationSec);
      }
      break;
    }

    info.captureFps = findCaptureFps(view, moov);
    return info;
  } catch {
    return { ...EMPTY };
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * QuickTime metadata (`meta` > `keys` + `ilst`). Android stores
 * `com.android.capture.fps` as a float, which is the real slow-mo rate.
 */
function findCaptureFps(view: DataView, moov: Box): number | null {
  const metas: Box[] = [];
  const walk = (box: Box) => {
    for (const c of children(view, box.start, box.end)) {
      if (c.type === 'meta') metas.push(c);
      else if (CONTAINERS.has(c.type)) walk(c);
    }
  };
  walk(moov);

  for (const meta of metas) {
    // QuickTime `meta` has no version/flags; ISO `meta` does. Try both.
    for (const offset of [0, 4]) {
      const inner: Box = { type: 'meta', start: meta.start + offset, end: meta.end };
      const keys = findChild(view, inner, 'keys');
      const ilst = findChild(view, inner, 'ilst');
      if (!keys || !ilst) continue;

      const names: string[] = [];
      const count = view.getUint32(keys.start + 4);
      let p = keys.start + 8;
      for (let i = 0; i < count && p + 8 <= keys.end; i++) {
        const size = view.getUint32(p);
        let name = '';
        for (let j = p + 8; j < p + size; j++) name += String.fromCharCode(view.getUint8(j));
        names.push(name);
        p += size;
      }
      const idx = names.findIndex(
        (n) => n.includes('capture.fps') || ((n.includes('framerate') || n.includes('frame-rate')) && !n.includes('intent')),
      );
      if (idx < 0) continue;

      for (const item of children(view, ilst.start, ilst.end)) {
        const keyIndex = view.getUint32(item.start - 4); // the box "type" is the 1-based key index
        if (keyIndex !== idx + 1) continue;
        const data = findChild(view, item, 'data');
        if (!data) continue;
        const kind = view.getUint32(data.start) & 0xffffff;
        const v = data.start + 8;
        let value: number | null = null;
        if (kind === 23) value = view.getFloat32(v);
        else if (kind === 24) value = view.getFloat64(v);
        else if (kind === 1) {
          let s = '';
          for (let j = v; j < data.end; j++) s += String.fromCharCode(view.getUint8(j));
          value = parseFloat(s);
        } else if (kind === 21 || kind === 22) {
          const len = data.end - v;
          value = len >= 4 ? view.getUint32(v) : len === 2 ? view.getUint16(v) : view.getUint8(v);
        }
        if (value && isFinite(value) && value > 0) return round2(value);
      }
    }
  }
  return null;
}
