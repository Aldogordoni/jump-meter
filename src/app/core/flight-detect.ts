/**
 * Pure analysis of body positions over time – no MediaPipe in here so it is easy to test.
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
  /** Mid-hip height, used to find the start of the countermovement. */
  hipY?: number;
  /** Nose and lowest heel, used for body size (frame-rate check). */
  noseY?: number;
  heelY?: number;
}

export type DetectMode = 'single' | 'drop';

export interface FlightEstimate {
  /** First frame judged to be in the air. */
  firstAir: number;
  /** First frame judged to be back on the ground. */
  firstGround: number;
  /** Sub-frame take-off / landing instants (fractional frame index). */
  takeoffExact: number;
  landingExact: number;
  /** Drop jump: first frame touching the floor after stepping off the box. */
  contact: number | null;
  contactExact: number | null;
  /** Start of the countermovement (single jumps), if one was found. */
  movementStart: number | null;
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

function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

export class DetectionError extends Error {}

/** Rough location of the jump from sparse samples. */
export interface CoarseResult {
  mode: DetectMode;
  lastGroundBefore: number;
  firstAirCoarse: number;
  lastAirCoarse: number;
  firstGroundAfter: number;
  /** Drop jump: last sparse sample in the air (off the box) before floor contact, and the first on the floor. */
  dropLastAir: number | null;
  dropFirstGround: number | null;
  peakFrame: number;
  legLen: number;
  /** Floor level (footY). */
  baseline: number;
}

interface Run {
  start: number; // index into ok[]
  end: number; // inclusive
}

export function coarseLocate(samples: FootSample[], mode: DetectMode = 'single'): CoarseResult {
  const ok = samples.filter((s) => isFinite(s.footY));
  if (ok.length < 8) {
    throw new DetectionError('No person found in enough frames. Film side-on with your whole body in shot.');
  }
  const legLen = median(ok.map((s) => s.legLen).filter((v) => v > 0));
  if (!(legLen > 0)) throw new DetectionError("Couldn't see your legs clearly. Film side-on with your whole body in shot.");

  // Floor level. Standing on the floor is the most common state in a normal jump clip;
  // in a drop jump you start on the box (higher), so take a high quantile instead.
  const baseline = mode === 'drop' ? quantile(ok.map((s) => s.footY), 0.8) : median(ok.map((s) => s.footY));
  const thr = 0.06 * legLen;
  const off = (s: FootSample) => s.footY < baseline - thr;

  // Contiguous runs of "feet clearly above the floor".
  const runs: Run[] = [];
  for (let i = 0; i < ok.length; i++) {
    if (!off(ok[i])) continue;
    const start = i;
    while (i + 1 < ok.length && off(ok[i + 1])) i++;
    runs.push({ start, end: i });
  }
  const rise = (r: Run) => Math.max(...ok.slice(r.start, r.end + 1).map((s) => baseline - s.footY));
  const jumps = runs.filter((r) => rise(r) >= 0.08 * legLen);
  if (!jumps.length) {
    throw new DetectionError("Couldn't find a jump: your feet never clearly leave the ground in this clip.");
  }

  let flight: Run;
  let dropLastAir: number | null = null;
  let dropFirstGround: number | null = null;

  if (mode === 'drop') {
    // The rebound is the last airborne run; the box/drop phase is the run before it.
    flight = jumps[jumps.length - 1];
    const before = runs.filter((r) => r.end < flight.start);
    if (!before.length) {
      throw new DetectionError(
        "Couldn't see the box landing before the rebound. Start filming while you're still on the box.",
      );
    }
    const drop = before[before.length - 1];
    dropLastAir = ok[drop.end].frame;
    dropFirstGround = ok[drop.end + 1].frame;
  } else {
    // The highest run is the jump.
    flight = jumps.reduce((a, b) => (rise(b) > rise(a) ? b : a));
  }

  if (flight.start === 0) {
    throw new DetectionError('The clip starts mid-air. Start recording a second before the jump.');
  }
  if (flight.end === ok.length - 1) {
    throw new DetectionError('The clip ends mid-air. Keep recording until a second after landing.');
  }
  let peak = ok[flight.start];
  for (let k = flight.start; k <= flight.end; k++) if (ok[k].footY < peak.footY) peak = ok[k];

  return {
    mode,
    lastGroundBefore: ok[flight.start - 1].frame,
    firstAirCoarse: ok[flight.start].frame,
    lastAirCoarse: ok[flight.end].frame,
    firstGroundAfter: ok[flight.end + 1].frame,
    dropLastAir,
    dropFirstGround,
    peakFrame: peak.frame,
    legLen,
    baseline,
  };
}

/**
 * Start of the countermovement: the hips drop below their standing height before take-off.
 * Returns the last frame where the hips were still at standing height, or null when
 * there's no clear dip (e.g. a squat jump).
 */
export function findMovementStart(coarse: CoarseResult, sparse: FootSample[], fps: number): number | null {
  const L = coarse.legLen;
  const pre = sparse.filter((s) => s.frame <= coarse.lastGroundBefore && isFinite(s.hipY ?? NaN));
  if (pre.length < 5) return null;
  // Look at most 2 s back from take-off for the deepest point of the dip.
  const windowStart = coarse.lastGroundBefore - 2 * fps;
  const recent = pre.filter((s) => s.frame >= windowStart);
  if (recent.length < 3) return null;
  const deepest = recent.reduce((a, b) => (b.hipY! > a.hipY! ? b : a));
  const earlier = pre.filter((s) => s.frame < deepest.frame);
  if (earlier.length < 2) return null;
  // Standing hip height: the earliest third of the samples before the dip.
  const standing = median(earlier.slice(0, Math.max(2, Math.ceil(earlier.length / 3))).map((s) => s.hipY!));
  if (deepest.hipY! - standing < 0.12 * L) return null; // no real countermovement

  const tol = 0.03 * L;
  for (let k = earlier.length - 1; k >= 0; k--) {
    if (earlier[k].hipY! <= standing + tol) return earlier[k].frame;
  }
  return null;
}

/**
 * Precise take-off and landing from dense (every-frame) samples around each event,
 * plus sparse samples for the floor level.
 */
export function refineFlight(
  coarse: CoarseResult,
  sparse: FootSample[],
  takeoffWindow: FootSample[],
  landingWindow: FootSample[],
  contactWindow: FootSample[] = [],
): FlightEstimate {
  const L = coarse.legLen;
  const ground = (arr: FootSample[]) =>
    arr.filter((s) => isFinite(s.footY) && Math.abs(s.footY - coarse.baseline) < 0.05 * L);

  const contactStart = coarse.dropFirstGround ?? -Infinity;
  const before = ground(sparse.filter((s) => s.frame <= coarse.lastGroundBefore && s.frame >= contactStart));
  const after = ground(sparse.filter((s) => s.frame >= coarse.firstGroundAfter));
  const baselineAfter = after.length >= 3 ? median(after.map((s) => s.footY)) : coarse.baseline;
  const baselineBefore = before.length >= 3 ? median(before.map((s) => s.footY)) : baselineAfter;

  const all = [...before, ...after].map((s) => s.footY);
  const centre = median(all);
  const noise = median(all.map((y) => Math.abs(y - centre)));
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

  const takeoffExact =
    extrapolateToFloor(
      up.slice(firstAirIdx).map((s, k) => ({ x: s.frame, h: hUp[firstAirIdx + k] })),
      threshold,
      'forward',
    ) ?? up[firstAirIdx].frame;

  const landing = findTouchdown(down, baselineAfter, threshold);
  if (!landing) throw new DetectionError("Couldn't pin down the landing frame.");

  let contact: { frame: number; exact: number } | null = null;
  if (coarse.mode === 'drop') {
    contact = findTouchdown(smooth(contactWindow), baselineBefore, threshold);
    if (!contact) throw new DetectionError("Couldn't pin down the box landing frame.");
  }

  // Times are in "frame units" where frame f is sampled at f + 0.5.
  // The threshold crossing can only be up to ~1 frame late (take-off) or early (landing).
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const firstAir = up[firstAirIdx].frame;
  const tExact = clamp(takeoffExact, firstAir - 1.5, firstAir + 0.5);
  // The frame marks shown to the user: first frame whose centre falls after each instant.
  const markOf = (exact: number) => Math.floor(exact - 0.5) + 1;
  return {
    firstAir: markOf(tExact),
    firstGround: markOf(landing.exact),
    takeoffExact: tExact,
    landingExact: landing.exact,
    contact: contact ? markOf(contact.exact) : null,
    contactExact: contact?.exact ?? null,
    movementStart: null,
    peakFrame: coarse.peakFrame,
    baselineBefore,
    baselineAfter,
    threshold,
  };
}

/** First air→ground transition in a window, with sub-frame timing. */
function findTouchdown(window: FootSample[], floor: number, threshold: number): { frame: number; exact: number } | null {
  const h = window.map((s) => floor - s.footY);
  let idx = h.findIndex((v, k) => k > 0 && v <= threshold && h[k - 1] > threshold);
  if (idx < 0) idx = h.findIndex((v) => v <= threshold);
  if (idx < 0) return null;
  const frame = window[idx].frame;
  const exact =
    extrapolateToFloor(
      window.slice(0, idx).map((s, k) => ({ x: s.frame, h: h[k] })),
      threshold,
      'backward',
    ) ?? frame;
  return { frame, exact: Math.min(frame + 1.5, Math.max(frame - 0.5, exact)) };
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
  // Samples sit at frame centres (f + 0.5).
  return mx - mh / slope + 0.5;
}
