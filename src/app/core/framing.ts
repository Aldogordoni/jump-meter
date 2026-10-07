/**
 * Live camera guidance: is the body framed well enough to time a jump, and is the
 * person standing still? Plus a tiny state machine that spots a jump in a live
 * stream of poses, for hands-free recording. Pure functions, no MediaPipe.
 */
import { median, type FootSample } from './flight-detect';

export type FramingIssue = 'none' | 'feet' | 'head' | 'close' | 'far' | 'centre' | 'good';

export interface Framing {
  issue: FramingIssue;
  message: string;
  ok: boolean;
}

const MESSAGES: Record<FramingIssue, string> = {
  none: 'Step into view, side-on to the camera.',
  feet: 'Your feet are cut off. Tilt the phone down or step back.',
  head: 'Your head is cut off. Step back so there is room to jump.',
  close: 'Step back a little: leave room above your head for the jump.',
  far: 'Come a bit closer so your feet are easier to track.',
  centre: 'Move towards the middle of the picture.',
  good: 'Good framing.',
};

export function framingOf(s: FootSample | null): Framing {
  const out = (issue: FramingIssue): Framing => ({ issue, message: MESSAGES[issue], ok: issue === 'good' });
  if (!s || !isFinite(s.footY) || !s.pts) return out('none');
  const p = s.pts;
  const feetVis = Math.max(...(['heelL', 'heelR', 'toeL', 'toeR'] as const).map((j) => p[j]?.[2] ?? 0));
  if (feetVis < 0.5 || s.footY > 0.975) return out('feet');
  const nose = s.noseY ?? NaN;
  if (!isFinite(nose) || nose < 0.04) return out('head');
  const span = s.footY - nose;
  if (span > 0.8) return out('close');
  if (span < 0.3) return out('far');
  const hipX = ((p.hipL?.[0] ?? 0.5) + (p.hipR?.[0] ?? 0.5)) / 2;
  if (hipX < 0.18 || hipX > 0.82) return out('centre');
  return out('good');
}

/** Standing still: hips and feet barely moved over the recent samples (normalised units). */
export function isStill(recent: FootSample[], legLen: number): boolean {
  const ok = recent.filter((s) => isFinite(s.footY) && isFinite(s.hipY ?? NaN));
  if (ok.length < 4 || !(legLen > 0)) return false;
  const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  return range(ok.map((s) => s.hipY!)) < 0.04 * legLen && range(ok.map((s) => s.footY)) < 0.03 * legLen;
}

export type WatchState = 'ground' | 'air' | 'landed' | 'done';

/**
 * Watches live poses for a jump. The floor is the lowest foot position seen recently,
 * so stepping off a box (drop jump) just lowers the floor. After a flight, waits until
 * the feet have been back on the floor for `settleMs` before reporting `done`.
 */
export class JumpWatcher {
  state: WatchState = 'ground';
  private floor = -Infinity;
  private legLens: number[] = [];
  private groundSince: number | null = null;
  flights = 0;

  constructor(private readonly settleMs = 1200) {}

  push(s: FootSample, tMs: number): WatchState {
    if (!isFinite(s.footY)) return this.state;
    if (s.legLen > 0) {
      this.legLens.push(s.legLen);
      if (this.legLens.length > 30) this.legLens.shift();
    }
    const L = median(this.legLens);
    if (!(L > 0)) return this.state;
    const thr = 0.08 * L;
    // Floor rises slowly back up (in case of a camera nudge) but drops instantly.
    this.floor = Math.max(this.floor - 0.002, s.footY);
    const airborne = s.footY < this.floor - thr;
    if (airborne) {
      if (this.state !== 'air') this.flights++;
      this.state = 'air';
      this.groundSince = null;
    } else if (this.state === 'air' || this.state === 'landed') {
      this.groundSince ??= tMs;
      this.state = tMs - this.groundSince >= this.settleMs ? 'done' : 'landed';
    }
    return this.state;
  }
}
