import { toUnits, type JumpRecord, type Units } from './jump-math';
import { formatNumber } from './height.pipe';
/**
 * Story-sized result card (1080 × 1350) for sharing: a key frame, the big number,
 * and the key stats. Drawn on a canvas, so it works offline.
 */
export interface ShareCardData {
  value: string; // "52.3"
  unit: string; // "cm"
  label: string; // "CMJ" or "Broad jump distance"
  date: string; // already formatted
  stats: string[]; // e.g. ["RSI 2.10", "Flight 652 ms"]
  pr: boolean;
  name?: string | null;
  image?: Blob | HTMLCanvasElement | null;
  /** The image is a clip poster with the result bar along the bottom: crop it off. */
  captioned?: boolean;
  dark?: boolean;
}

const W = 1080;
const H = 1350;

export async function drawShareCard(d: ShareCardData): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const ink = d.dark ? '#e8eef6' : '#172033';
  const soft = d.dark ? '#a5b2c6' : '#4b5872';
  const paper = d.dark ? '#0f1828' : '#edf1f5';
  const red = '#d7263d';
  const blue = '#1b5fd1';
  await Promise.all(
    ['700 160px "Barlow Condensed"', '600 48px "Barlow Condensed"', '500 36px Barlow'].map((f) =>
      document.fonts?.load(f).catch(() => undefined),
    ),
  );
  const display = '"Barlow Condensed", "Arial Narrow", sans-serif';
  const body = 'Barlow, system-ui, sans-serif';

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);

  // Key frame across the top, cover-cropped, fading into the background.
  const imgH = 720;
  const img = await toDrawable(d.image);
  if (img) {
    const iw = img.width;
    // Clip posters carry a caption bar 9% of the long side tall; leave it out.
    const ih = img.height - (d.captioned ? Math.ceil(0.09 * Math.max(img.width, img.height)) : 0);
    const s = Math.max(W / iw, imgH / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, imgH);
    ctx.clip();
    ctx.drawImage(img, 0, 0, iw, ih, (W - dw) / 2, (imgH - dh) / 2, dw, dh);
    ctx.restore();
    const g = ctx.createLinearGradient(0, imgH * 0.55, 0, imgH);
    g.addColorStop(0, hexA(paper, 0));
    g.addColorStop(1, paper);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, imgH);
  } else {
    // Vane bars as a backdrop when there's no picture.
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = i % 5 === 0 ? red : i % 2 ? hexA(ink, 0.12) : hexA(blue, 0.5);
      ctx.fillRect(90, 80 + i * 34, 420 + (i % 3) * 60, 18);
    }
  }

  // Badge
  let y = imgH - 40;
  if (d.pr) {
    ctx.font = `700 44px ${display}`;
    const text = 'NEW PERSONAL RECORD';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = red;
    roundRect(ctx, 80, y - 52, tw + 48, 68, 34);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 104, y);
  }

  // Big number
  y += 230;
  ctx.fillStyle = ink;
  ctx.font = `700 260px ${display}`;
  ctx.fillText(d.value, 72, y);
  const vw = ctx.measureText(d.value).width;
  ctx.font = `600 90px ${display}`;
  ctx.fillStyle = soft;
  ctx.fillText(d.unit, 72 + vw + 20, y);

  y += 80;
  ctx.font = `700 64px ${display}`;
  ctx.fillStyle = ink;
  ctx.fillText(d.label, 80, y);

  y += 60;
  ctx.font = `500 38px ${body}`;
  ctx.fillStyle = soft;
  ctx.fillText([d.name, d.date].filter(Boolean).join(' · '), 80, y);

  if (d.stats.length) {
    y += 70;
    ctx.font = `600 44px ${display}`;
    ctx.fillStyle = blue;
    ctx.fillText(d.stats.slice(0, 3).join('   ·   '), 80, y);
  }

  // Footer wordmark
  ctx.fillStyle = red;
  ctx.fillRect(80, H - 92, 34, 9);
  ctx.fillStyle = hexA(ink, 0.35);
  ctx.fillRect(80, H - 78, 42, 9);
  ctx.fillStyle = blue;
  ctx.fillRect(80, H - 64, 48, 9);
  ctx.font = `700 46px ${display}`;
  ctx.fillStyle = ink;
  ctx.fillText('Jump Meter', 144, H - 54);

  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

/** Share through the system sheet when possible, otherwise download. */
export async function shareImage(blob: Blob, fileName: string, title: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

async function toDrawable(src: Blob | HTMLCanvasElement | null | undefined): Promise<CanvasImageSource & { width: number; height: number } | null> {
  if (!src) return null;
  if (src instanceof HTMLCanvasElement) return src.width ? src : null;
  try {
    return await createImageBitmap(src);
  } catch {
    return null;
  }
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

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Card contents for a saved jump. */
export function cardDataFor(
  r: JumpRecord,
  units: Units,
  extra: { pr: boolean; name?: string | null; image?: Blob | HTMLCanvasElement | null; captioned?: boolean },
): ShareCardData {
  const byDistance = r.type === 'Broad jump' && r.distanceCm !== undefined;
  const cm = byDistance ? r.distanceCm! : r.heightCm;
  const stats: string[] = [];
  if (r.hops?.length && r.rsi !== undefined) stats.push(`RSI ${r.rsi.toFixed(2)} (best 5)`);
  else if (r.rsi !== undefined) stats.push(`RSI ${r.rsi.toFixed(2)}`);
  if (r.rsiMod !== undefined) stats.push(`RSI-mod ${r.rsiMod.toFixed(2)}`);
  if (r.contactMs !== undefined) stats.push(`Contact ${Math.round(r.contactMs)} ms`);
  if (byDistance) stats.push(`Height ${formatNumber(toUnits(r.heightCm, units), 1)} ${units}`);
  if (r.reachCm !== undefined) stats.push(`Reach +${formatNumber(toUnits(r.reachCm, units), 1)} ${units}`);
  if (stats.length < 2) stats.push(`Flight ${Math.round(r.flightMs)} ms`);
  return {
    value: formatNumber(toUnits(cm, units), 1),
    unit: units,
    label: byDistance ? 'Broad jump' : r.type === 'Repeated jumps' ? 'Repeated jumps, best 5' : r.type,
    date: new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    stats,
    pr: extra.pr,
    name: extra.name,
    image: extra.image,
    captioned: extra.captioned,
    dark: matchMedia?.('(prefers-color-scheme: dark)').matches,
  };
}
