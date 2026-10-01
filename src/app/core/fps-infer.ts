/**
 * Work out the real capture frame rate from the jump itself.
 *
 * In the air the hips follow a parabola under gravity. In image units per frame²
 * its curvature is  a = ½·g / (S·fps²),  where S is metres per image unit.
 * S comes from the person's size in the image and their (assumed or entered) height,
 * so  fps = √(½·g / (S·a)).
 *
 * Body size is only known to roughly ±8%, giving about ±4% on fps. That's not
 * precise enough to replace the file's frame rate, but more than enough to spot
 * slow-motion factors (2×, 4×, 8×), which is what goes wrong in practice.
 */
import { G } from './jump-math';
import { median } from './flight-detect';

export interface PosePoint {
  frame: number;
  hipY?: number;
  noseY?: number;
  heelY?: number;
}

export interface FpsEstimate {
  /** Raw estimate from the motion. */
  fps: number;
  /** How well the hips fit a parabola (R²). */
  fit: number;
  points: number;
}

/** Nose-to-heel distance as a fraction of standing height (adult average). */
const NOSE_TO_HEEL = 0.935;

export function estimateFps(
  flight: PosePoint[],
  standing: PosePoint[],
  statureM: number,
): FpsEstimate | null {
  const pts = flight.filter((p) => isFinite(p.hipY ?? NaN));
  if (pts.length < 6) return null;
  const bodies = standing
    .filter((p) => isFinite(p.noseY ?? NaN) && isFinite(p.heelY ?? NaN))
    .map((p) => p.heelY! - p.noseY!)
    .filter((v) => v > 0.05);
  if (bodies.length < 2) return null;
  const bodyNorm = median(bodies);
  const metresPerUnit = (statureM * NOSE_TO_HEEL) / bodyNorm;

  const fit = fitQuadratic(
    pts.map((p) => p.frame),
    pts.map((p) => p.hipY!),
  );
  if (!fit || fit.a <= 0) return null;
  const fps = Math.sqrt((0.5 * G) / (metresPerUnit * fit.a));
  if (!isFinite(fps) || fps <= 0) return null;
  return { fps, fit: fit.r2, points: pts.length };
}

/**
 * Pick the frame rate to use. The file's rate wins unless the motion clearly
 * matches a slow-motion multiple of it (×2, ×4, ×8…) or a fraction.
 */
export function reconcileFps(
  fileFps: number,
  est: FpsEstimate,
): { fps: number; agrees: boolean; factor: number } | null {
  if (est.fit < 0.9) return null;
  const k = Math.round(Math.log2(est.fps / fileFps));
  const candidate = fileFps * 2 ** k;
  const off = Math.abs(Math.log(est.fps / candidate));
  if (off > Math.log(1.22)) return null; // doesn't line up with any sensible rate
  return { fps: Math.round(candidate * 100) / 100, agrees: k === 0, factor: 2 ** k };
}

function fitQuadratic(xs: number[], ys: number[]): { a: number; b: number; c: number; r2: number } | null {
  const n = xs.length;
  const x0 = xs.reduce((s, v) => s + v, 0) / n;
  const X = xs.map((x) => x - x0);
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = X[i], y = ys[i], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  // Solve [[s4 s3 s2][s3 s2 s1][s2 s1 s0]] · [a b c] = [t2 t1 t0]
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  const col = (j: number, v: number[]) => M.map((row, i) => row.map((c, k) => (k === j ? v[i] : c)));
  const T = [t2, t1, t0];
  const a = det(col(0, T)) / D;
  const b = det(col(1, T)) / D;
  const c = det(col(2, T)) / D;
  const mean = t0 / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = a * X[i] * X[i] + b * X[i] + c;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  return { a, b, c, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}
