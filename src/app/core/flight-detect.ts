/**
 * Pure analysis of foot positions over time – no MediaPipe in here so it is easy to test.
 *
 * All y values are normalised image coordinates (0 = top, 1 = bottom), so a foot
 * leaving the ground means its y gets *smaller*.
 */

export interface FootSample {
  frame: number;
  /** Lowest point of the feet (max y over heels and toes). */
  footY: number;
  /** Vertical hip-to-ankle distance, used as a body-size scale. */
  legLen: number;
}

export interface FlightEstimate {
  /** First frame judged to be in the air. */
  firstAir: number;
  /** First frame judged to be back on the ground. */
  firstGround: number;
  /** Sub-frame take-off / landing instants (fractional frame index). */
  takeoffExact: number;
  landingExact: number;
  /** Peak frame (highest foot position). */
  peakFrame: number;
  baselineBefore: number;
  baselineAfter: number;
  threshold: number;
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class DetectionError extends Error {}

/** Rough location of the jump from sparse samples. */
export interface CoarseResult {
  lastGroundBefore: number;
  firstAirCoarse: number;
  lastAirCoarse: number;
  firstGroundAfter: number;
  peakFrame: number;
  legLen: number;
  baseline: number;
}

export function coarseLocate(samples: FootSample[]): CoarseResult {
  const ok = samples.filter((s) => isFinite(s.footY));
  if (ok.length < 8) {
    throw new DetectionError('No person found in enough frames. Film side-on with your whole body in shot.');
  }
  const legLen = median(ok.map((s) => s.legLen).filter((v) => v > 0));
  const baseline = median(ok.map((s) => s.footY));
  let peak = ok[0];
  for (const s of ok) if (s.footY < peak.footY) peak = s;

  if (!(legLen > 0) || baseline - peak.footY < 0.08 * legLen) {
    throw new DetectionError("Couldn't find a jump: your feet never clearly leave the ground in this clip.");
  }
  const thr = 0.06 * legLen;
  const peakIdx = ok.indexOf(peak);

  let i = peakIdx;
  while (i > 0 && ok[i].footY < baseline - thr) i--;
  if (ok[i].footY < baseline - thr) {
    throw new DetectionError('The clip starts mid-air. Start recording a second before the jump.');
  }
  let j = peakIdx;
  while (j < ok.length - 1 && ok[j].footY < baseline - thr) j++;
  if (ok[j].footY < baseline - thr) {
    throw new DetectionError('The clip ends mid-air. Keep recording until a second after landing.');
  }
  return {
    lastGroundBefore: ok[i].frame,
    firstAirCoarse: ok[i + 1].frame,
    lastAirCoarse: ok[j - 1].frame,
    firstGroundAfter: ok[j].frame,
    peakFrame: peak.frame,
    legLen,
    baseline,
  };
}

/**
 * Precise take-off and landing from dense (every-frame) samples around each event,
 * plus sparse samples for the standing baselines.
 */
export function refineFlight(
  coarse: CoarseResult,
  sparse: FootSample[],
  takeoffWindow: FootSample[],
  landingWindow: FootSample[],
): FlightEstimate {
  const L = coarse.legLen;
  const ground = (arr: FootSample[]) => arr.filter((s) => isFinite(s.footY) && Math.abs(s.footY - coarse.baseline) < 0.05 * L);

  const before = ground(sparse.filter((s) => s.frame <= coarse.lastGroundBefore));
  const after = ground(sparse.filter((s) => s.frame >= coarse.firstGroundAfter));
  const baselineBefore = before.length >= 3 ? median(before.map((s) => s.footY)) : coarse.baseline;
  const baselineAfter = after.length >= 3 ? median(after.map((s) => s.footY)) : coarse.baseline;

  const noise = median([...before, ...after].map((s) => Math.abs(s.footY - median([...before, ...after].map((x) => x.footY)))));
  const threshold = Math.max(0.02 * L, 4 * 1.4826 * (isFinite(noise) ? noise : 0));

  const up = smooth(takeoffWindow);
  const down = smooth(landingWindow);
  if (up.length < 3 || down.length < 3) throw new DetectionError('Not enough frames around the jump to measure it.');

  // Take-off: the last ground→air transition in the window.
  const hUp = up.map((s) => baselineBefore - s.footY); // height above floor
  let firstAirIdx = -1;
  for (let k = hUp.length - 1; k > 0; k--) {
    if (hUp[k] > threshold && hUp[k - 1] <= threshold) {
      firstAirIdx = k;
      break;
    }
  }
  if (firstAirIdx < 0) firstAirIdx = hUp.findIndex((h) => h > threshold);
  if (firstAirIdx < 0) throw new DetectionError("Couldn't pin down the take-off frame.");

  // Landing: the first air→ground transition in the window.
  const hDown = down.map((s) => baselineAfter - s.footY);
  let firstGroundIdx = hDown.findIndex((h, k) => k > 0 && h <= threshold && hDown[k - 1] > threshold);
  if (firstGroundIdx < 0) firstGroundIdx = hDown.findIndex((h) => h <= threshold);
  if (firstGroundIdx < 0) throw new DetectionError("Couldn't pin down the landing frame.");

  const firstAir = up[firstAirIdx].frame;
  const firstGround = down[firstGroundIdx].frame;

  // Sub-frame: extrapolate the foot's path back to the floor (height 0).
  const takeoffExact = extrapolateToFloor(
    up.slice(firstAirIdx).map((s, k) => ({ x: s.frame, h: hUp[firstAirIdx + k] })),
    threshold,
    'forward',
  ) ?? firstAir;
  const landingExact = extrapolateToFloor(
    down.slice(0, firstGroundIdx).map((s, k) => ({ x: s.frame, h: hDown[k] })),
    threshold,
    'backward',
  ) ?? firstGround;

  // Times are in "frame units" where frame f is sampled at f + 0.5.
  // The threshold crossing can only be up to ~1 frame late (take-off) or early (landing).
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const tExact = clamp(takeoffExact, firstAir - 1.5, firstAir + 0.5);
  const lExact = clamp(landingExact, firstGround - 0.5, firstGround + 1.5);
  // The frame marks shown to the user: first frame whose centre falls after each instant.
  return {
    firstAir: Math.floor(tExact - 0.5) + 1,
    firstGround: Math.floor(lExact - 0.5) + 1,
    takeoffExact: tExact,
    landingExact: lExact,
    peakFrame: coarse.peakFrame,
    baselineBefore,
    baselineAfter,
    threshold,
  };
}

/** 3-point median filter to knock out single-frame landmark jitter. */
function smooth(samples: FootSample[]): FootSample[] {
  const ok = samples.filter((s) => isFinite(s.footY));
  return ok.map((s, i) => {
    if (i === 0 || i === ok.length - 1) return s;
    return { ...s, footY: median([ok[i - 1].footY, s.footY, ok[i + 1].footY]) };
  });
}

/**
 * Fit a straight line through the first (take-off) or last (landing) few airborne
 * points that are still close to the floor, and return where it crosses h = 0.
 */
function extrapolateToFloor(
  pts: { x: number; h: number }[],
  threshold: number,
  dir: 'forward' | 'backward',
): number | null {
  const ordered = dir === 'forward' ? pts : [...pts].reverse();
  const near = ordered.filter((p) => p.h > 0 && p.h < threshold * 5).slice(0, 4);
  if (near.length < 2) return null;
  const n = near.length;
  const mx = near.reduce((a, p) => a + p.x, 0) / n;
  const mh = near.reduce((a, p) => a + p.h, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of near) {
    num += (p.x - mx) * (p.h - mh);
    den += (p.x - mx) ** 2;
  }
  if (!den) return null;
  const slope = num / den;
  if (dir === 'forward' ? slope <= 0 : slope >= 0) return null;
  // The instant is reported as a frame *boundary*: frame f spans [f, f+1),
  // our samples sit at frame centres (f + 0.5).
  return mx - mh / slope + 0.5;
}
