/**
 * Deeper analysis from pose landmarks: landing posture, arm swing, movement phases
 * (kinematics), confidence, and repeated-jump hops. Pure functions over samples.
 *
 * Coordinates are normalised to the image (x by width, y by height), so x is scaled by
 * the aspect ratio before measuring angles.
 */
import { G, heightFromFlight, type Confidence, type Hop, type Kinematics, type PostureCheck } from './jump-math';
import { extrapolateToFloor, median, smooth, type FootSample, type Joint } from './flight-detect';

/** Nose-to-heel distance as a fraction of standing height (adult average). */
const NOSE_TO_HEEL = 0.935;

/** Metres per normalised image unit, from body size while standing. */
export function metresPerUnit(standing: FootSample[], statureM: number): number | null {
  const bodies = standing
    .filter((s) => isFinite(s.noseY ?? NaN) && isFinite(s.heelY ?? NaN))
    .map((s) => s.heelY! - s.noseY!)
    .filter((v) => v > 0.05);
  if (bodies.length < 1) return null;
  return (statureM * NOSE_TO_HEEL) / median(bodies);
}

type P = [number, number, number];

function angle(a: P | undefined, b: P | undefined, c: P | undefined, aspect: number): number | null {
  if (!a || !b || !c || Math.min(a[2], b[2], c[2]) < 0.3) return null;
  const v1 = [(a[0] - b[0]) * aspect, a[1] - b[1]];
  const v2 = [(c[0] - b[0]) * aspect, c[1] - b[1]];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const n = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
  if (!n) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180) / Math.PI;
}

/** Joint angle averaged over both sides (whichever are visible). */
function bilateral(s: FootSample, a: [Joint, Joint], b: [Joint, Joint], c: [Joint, Joint], aspect: number): number | null {
  const p = s.pts ?? {};
  const vals = [angle(p[a[0]], p[b[0]], p[c[0]], aspect), angle(p[a[1]], p[b[1]], p[c[1]], aspect)].filter(
    (v): v is number => v !== null,
  );
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
}

export const kneeAngle = (s: FootSample, aspect: number) =>
  bilateral(s, ['hipL', 'hipR'], ['kneeL', 'kneeR'], ['ankleL', 'ankleR'], aspect);
export const hipAngle = (s: FootSample, aspect: number) =>
  bilateral(s, ['shoulderL', 'shoulderR'], ['hipL', 'hipR'], ['kneeL', 'kneeR'], aspect);

/**
 * Landing technique. Flight-time testing assumes you land in the same position you took
 * off in. Landing with bent knees lowers the hips, so you're in the air longer and the
 * height reads high. Compares knee/hip angles and hip height at take-off vs touchdown.
 */
export function postureCheck(
  takeoff: FootSample,
  landing: FootSample,
  flightSec: number,
  metresPerUnitValue: number | null,
  aspect: number,
): PostureCheck | null {
  const kT = kneeAngle(takeoff, aspect);
  const kL = kneeAngle(landing, aspect);
  const hT = hipAngle(takeoff, aspect);
  const hL = hipAngle(landing, aspect);
  if (kT === null || kL === null) return null;

  // Extra drop of the hips at touchdown, metres.
  let dropM = 0;
  if (metresPerUnitValue && isFinite(takeoff.hipY ?? NaN) && isFinite(landing.hipY ?? NaN)) {
    // The body is in a different place in the air, so compare hip height above the feet.
    const hipAboveFeetT = takeoff.footY - takeoff.hipY!;
    const hipAboveFeetL = landing.footY - landing.hipY!;
    dropM = Math.max(0, (hipAboveFeetT - hipAboveFeetL) * metresPerUnitValue);
  }
  // Time to fall that extra distance, starting at take-off speed.
  const v = (G * flightSec) / 2;
  const extraT = dropM > 0 ? (-v + Math.sqrt(v * v + 2 * G * dropM)) / G : 0;
  const inflationCm = Math.max(0, (heightFromFlight(flightSec) - heightFromFlight(flightSec - extraT)) * 100);

  const kneeDiff = kT - kL;
  return {
    kneeTakeoff: Math.round(kT),
    kneeLanding: Math.round(kL),
    hipTakeoff: Math.round(hT ?? 0),
    hipLanding: Math.round(hL ?? 0),
    flagged: kneeDiff > 15 || inflationCm > 1.5,
    inflationCm: Math.round(inflationCm * 10) / 10,
  };
}

/**
 * Arm swing: during the push-off, at least one wrist rises clearly above shoulder height
 * (hands on hips keeps the wrists near the hips).
 */
export function detectArmSwing(pushOff: FootSample[]): boolean | null {
  const rises: number[] = [];
  for (const s of pushOff) {
    const p = s.pts;
    if (!p || !(s.legLen > 0)) continue;
    for (const [w, sh] of [['wristL', 'shoulderL'], ['wristR', 'shoulderR']] as [Joint, Joint][]) {
      const wp = p[w];
      const sp = p[sh];
      if (wp && sp && wp[2] > 0.3 && sp[2] > 0.3) rises.push((sp[1] - wp[1]) / s.legLen);
    }
  }
  if (rises.length < 2) return null;
  return Math.max(...rises) > 0.15;
}

/**
 * Movement phases from the hip trajectory before take-off.
 * `timeOf(frame)` returns real-world seconds.
 */
export function kinematics(opts: {
  samples: FootSample[]; // dense-ish, standing → take-off
  movementStart: number | null;
  takeoffFrame: number;
  timeOf: (frame: number) => number;
  metresPerUnit: number | null;
  flightSec: number;
  massKg: number | null;
}): Kinematics {
  const takeoffVelocity = (G * opts.flightSec) / 2;
  const base: Kinematics = {
    depthCm: null,
    eccentricMs: null,
    concentricMs: null,
    takeoffVelocity: Math.round(takeoffVelocity * 100) / 100,
    peakVelocity: null,
    momentum: opts.massKg ? Math.round(opts.massKg * takeoffVelocity) : null,
  };
  const S = opts.metresPerUnit;
  const pts = opts.samples
    .filter((s) => isFinite(s.hipY ?? NaN) && s.frame <= opts.takeoffFrame)
    .sort((a, b) => a.frame - b.frame);
  if (!S || pts.length < 5) return base;

  const start = opts.movementStart ?? pts[0].frame;
  const before = pts.filter((s) => s.frame <= start);
  const standY = median((before.length ? before : pts.slice(0, 3)).map((s) => s.hipY!));
  const phase = pts.filter((s) => s.frame >= start);
  if (phase.length < 4) return base;
  const lowest = phase.reduce((a, b) => (b.hipY! > a.hipY! ? b : a));
  const depthM = (lowest.hipY! - standY) * S;
  if (depthM < 0.04) return base; // no real countermovement (e.g. squat jump)

  // Upward hip velocity during the push (m/s), from a smoothed height curve.
  const push = smooth(pts.filter((s) => s.frame >= lowest.frame).map((s) => ({ ...s, footY: s.hipY! })));
  let peak = 0;
  for (let i = 1; i < push.length; i++) {
    const dt = opts.timeOf(push[i].frame) - opts.timeOf(push[i - 1].frame);
    if (dt <= 0) continue;
    const v = ((push[i - 1].footY - push[i].footY) * S) / dt;
    if (v > peak && v < 6) peak = v;
  }
  return {
    ...base,
    depthCm: Math.round(depthM * 1000) / 10,
    eccentricMs: opts.movementStart !== null ? Math.round((opts.timeOf(lowest.frame) - opts.timeOf(start)) * 1000) : null,
    concentricMs: Math.round((opts.timeOf(opts.takeoffFrame) - opts.timeOf(lowest.frame)) * 1000),
    peakVelocity: peak > 0 ? Math.round(peak * 100) / 100 : null,
  };
}

/** How much to trust a result, with reasons a person can act on. */
export function confidenceOf(f: {
  fps: number;
  auto: boolean;
  subFrame: boolean;
  fpsCheck: 'agrees' | 'corrected' | 'suggest' | 'unavailable' | 'idle' | 'running';
  poseVisibility: number | null; // 0–1 feet visibility around take-off/landing
  postureFlagged: boolean;
  implausible: boolean;
}): Confidence {
  let score = 100;
  const reasons: string[] = [];
  if (f.fps < 100) {
    score -= 35;
    reasons.push(`Low frame rate (${Math.round(f.fps)} fps): timing is only accurate to about ±${Math.round(((9.81 * 0.5) / f.fps / 4) * 100)} cm.`);
  } else if (f.fps < 200) {
    score -= 12;
    reasons.push('120 fps is good; 240 fps slow motion is better.');
  }
  if (f.fpsCheck === 'suggest') {
    score -= 25;
    reasons.push("The jump's motion doesn't match the frame rate you set.");
  } else if (f.fpsCheck === 'unavailable') {
    score -= 8;
    reasons.push("Couldn't double-check the frame rate against your motion.");
  }
  if (f.poseVisibility !== null && f.poseVisibility < 0.6) {
    score -= 15;
    reasons.push('Your feet were hard to see. Better light and a side-on view help.');
  }
  if (f.postureFlagged) {
    score -= 20;
    reasons.push('Bent-knee landing: the height may read high.');
  }
  if (f.implausible) {
    score -= 30;
    reasons.push('The times are outside a normal jump.');
  }
  if (f.auto && f.subFrame) score = Math.min(100, score + 5);
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low', reasons };
}

/** Average foot visibility of the samples (for confidence). */
export function footVisibility(samples: FootSample[]): number | null {
  const v: number[] = [];
  for (const s of samples) for (const j of ['heelL', 'heelR', 'toeL', 'toeR'] as Joint[]) if (s.pts?.[j]) v.push(s.pts[j]![2]);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ---------------------------------------------------------------------------
// Repeated jumps (10/5 test, pogo hops)
// ---------------------------------------------------------------------------

export interface HopEvent {
  takeoff: number; // exact, frame units
  landing: number; // exact
}

/**
 * Every flight in a dense foot trace. `floor` is the standing foot level; hops count when
 * the feet rise more than `threshold` above it.
 */
export function findHops(dense: FootSample[], floor: number, threshold: number): HopEvent[] {
  const pts = smooth(dense.filter((s) => isFinite(s.footY)));
  const h = pts.map((s) => floor - s.footY);
  const out: HopEvent[] = [];
  let i = 1;
  while (i < pts.length) {
    // ground → air
    if (h[i] > threshold && h[i - 1] <= threshold) {
      const up = i;
      let j = i;
      while (j < pts.length && h[j] > threshold) j++;
      if (j >= pts.length) break; // clip ends mid-air
      const down = j; // first frame back on the ground
      const air = pts.slice(up, down);
      // Ignore blips: real hops rise at least 2× the threshold.
      if (Math.max(...h.slice(up, down)) >= threshold * 2 && air.length >= 2) {
        const takeoff =
          extrapolateToFloor(air.map((s, k) => ({ x: s.frame, h: h[up + k] })), threshold, 'forward') ?? pts[up].frame;
        const landing =
          extrapolateToFloor(air.map((s, k) => ({ x: s.frame, h: h[up + k] })), threshold, 'backward') ?? pts[down].frame;
        const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
        out.push({
          takeoff: clamp(takeoff, pts[up - 1].frame + 0.5, pts[up].frame + 0.5),
          landing: clamp(landing, pts[down - 1].frame + 0.5, pts[down].frame + 0.5),
        });
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Turn hop events into flight/contact/RSI, using real time per frame. */
export function hopsToStats(events: HopEvent[], secondsBetween: (a: number, b: number) => number): Hop[] {
  return events.map((e, k) => {
    const flight = secondsBetween(e.takeoff, e.landing);
    const contact = k > 0 ? secondsBetween(events[k - 1].landing, e.takeoff) : null;
    const heightCm = heightFromFlight(flight) * 100;
    return {
      flightMs: Math.round(flight * 1000),
      contactMs: contact !== null ? Math.round(contact * 1000) : null,
      heightCm: Math.round(heightCm * 10) / 10,
      // Ignore the long pause before the first hop and any reset between sets.
      rsi: contact !== null && contact < 1 ? Math.round((heightCm / 100 / contact) * 100) / 100 : null,
    };
  });
}

/** 10/5 test score: mean RSI of the best five hops. */
export function best5Rsi(hops: Hop[]): { rsi: number; contactMs: number; heightCm: number } | null {
  const valid = hops.filter((h) => h.rsi !== null).sort((a, b) => b.rsi! - a.rsi!);
  if (!valid.length) return null;
  const top = valid.slice(0, 5);
  const avg = (f: (h: Hop) => number) => top.reduce((a, h) => a + f(h), 0) / top.length;
  return {
    rsi: Math.round(avg((h) => h.rsi!) * 100) / 100,
    contactMs: Math.round(avg((h) => h.contactMs!)),
    heightCm: Math.round(avg((h) => h.heightCm) * 10) / 10,
  };
}

export interface CoarseHops {
  floor: number;
  threshold: number;
  /** Frame windows around each take-off and landing, for dense sampling. */
  transitions: { from: number; to: number }[];
}

/**
 * Rough hop locations from a sparse scan. The floor is a high quantile of foot height,
 * since in a hopping clip the feet are in the air much of the time.
 */
export function coarseHops(sparse: FootSample[]): CoarseHops | null {
  const ok = sparse.filter((s) => isFinite(s.footY));
  if (ok.length < 8) return null;
  const legLen = median(ok.map((s) => s.legLen).filter((v) => v > 0));
  if (!(legLen > 0)) return null;
  const ys = ok.map((s) => s.footY).sort((a, b) => a - b);
  const floor = ys[Math.min(ys.length - 1, Math.round(0.85 * (ys.length - 1)))];
  const threshold = 0.05 * legLen;
  const transitions: { from: number; to: number }[] = [];
  for (let i = 1; i < ok.length; i++) {
    const was = floor - ok[i - 1].footY > threshold;
    const is = floor - ok[i].footY > threshold;
    if (was !== is) transitions.push({ from: ok[i - 1].frame, to: ok[i].frame });
  }
  return transitions.length >= 2 ? { floor, threshold, transitions } : null;
}

/** Horizontal or vertical distance between two image points, in cm, given a scale. */
export function scaledDistanceCm(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  cmPerPx: number,
  axis: 'x' | 'y' | 'both',
): number {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  const px = axis === 'x' ? dx : axis === 'y' ? dy : Math.hypot(dx, dy);
  return px * cmPerPx;
}
