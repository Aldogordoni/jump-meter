/**
 * Sports-science maths on top of the jump history. Pure functions, no Angular, so
 * they're easy to unit test (see tests/insights.test.mts).
 *
 * Conventions follow common practice in jump monitoring:
 *  - a *session* is a set of jumps done together; its score is the best jump or the
 *    mean of the best three;
 *  - *smallest worthwhile change* (SWC) = 0.2 × the between-session standard deviation;
 *  - *coefficient of variation* (CV) = SD / mean of the jumps within a session.
 */
import type { JumpRecord, JumpType } from './jump-math';

export type SessionScoreMode = 'best' | 'mean3';
export type Metric = 'heightCm' | 'rsi' | 'rsiMod';

/** Jumps closer together than this belong to the same session. */
export const SESSION_GAP_MS = 90 * 60_000;

export interface Session {
  id: string;
  type: JumpType;
  start: string; // ISO of first jump
  jumps: JumpRecord[]; // oldest first
  /** Session score for the chosen metric. */
  score: number;
  best: number;
  mean: number;
  /** Within-session coefficient of variation, %, when there are 2+ jumps. */
  cv: number | null;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function metricOf(r: JumpRecord, metric: Metric): number | undefined {
  const v = r[metric];
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/**
 * Group jumps of one type into sessions. Uses the stored sessionId when present
 * (jumps saved together), otherwise jumps within SESSION_GAP_MS of each other.
 */
export function groupSessions(
  records: JumpRecord[],
  type: JumpType,
  metric: Metric = 'heightCm',
  mode: SessionScoreMode = 'best',
): Session[] {
  const rs = records
    .filter((r) => r.type === type && metricOf(r, metric) !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
  const groups: JumpRecord[][] = [];
  for (const r of rs) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    const sameById = !!prev && !!r.sessionId && prev.sessionId === r.sessionId;
    const sameByTime =
      !!prev && !r.sessionId && !prev.sessionId && Date.parse(r.date) - Date.parse(prev.date) <= SESSION_GAP_MS;
    if (last && (sameById || sameByTime)) last.push(r);
    else groups.push([r]);
  }
  return groups.map((jumps) => {
    const values = jumps.map((j) => metricOf(j, metric)!);
    const sorted = [...values].sort((a, b) => b - a);
    const best = sorted[0];
    const top3 = sorted.slice(0, 3);
    const m = mean(values);
    const s = sd(values);
    return {
      id: jumps[0].sessionId ?? jumps[0].id,
      type,
      start: jumps[0].date,
      jumps,
      best,
      mean: m,
      score: mode === 'best' ? best : mean(top3),
      cv: values.length >= 2 ? (s / m) * 100 : null,
    };
  });
}

/** Which session (if any) a new jump joins: the latest one of any type within the gap. */
export function sessionIdFor(records: JumpRecord[], date: string): string | null {
  const t = Date.parse(date);
  let best: JumpRecord | null = null;
  for (const r of records) {
    const d = Math.abs(t - Date.parse(r.date));
    if (d <= SESSION_GAP_MS && (!best || d < Math.abs(t - Date.parse(best.date)))) best = r;
  }
  return best ? (best.sessionId ?? best.id) : null;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type ReadinessStatus = 'fresh' | 'normal' | 'slightly-down' | 'fatigued';

export interface Readiness {
  status: ReadinessStatus;
  /** Latest session score. */
  latest: number;
  baseline: number;
  /** Between-session SD of the baseline window. */
  sd: number;
  swc: number;
  /** Difference from baseline in %. */
  diffPct: number;
  /** Standardised difference (z-score). */
  z: number;
  baselineSessions: number;
}

/**
 * Compare the latest session with a rolling baseline of the sessions in the
 * preceding `windowDays` (default 28). Needs at least 3 baseline sessions.
 */
export function readiness(sessions: Session[], windowDays = 28): Readiness | null {
  if (sessions.length < 4) return null;
  const latest = sessions.at(-1)!;
  const t = Date.parse(latest.start);
  let window = sessions.slice(0, -1).filter((s) => t - Date.parse(s.start) <= windowDays * 86_400_000);
  if (window.length < 3) window = sessions.slice(-8, -1); // fall back to the last few sessions
  if (window.length < 3) return null;
  const scores = window.map((s) => s.score);
  const baseline = mean(scores);
  // Guard against a tiny SD from very consistent early data: at least 1.5% of baseline.
  const s = Math.max(sd(scores), baseline * 0.015);
  const swc = 0.2 * s;
  const diff = latest.score - baseline;
  const status: ReadinessStatus =
    diff < -s ? 'fatigued' : diff < -swc ? 'slightly-down' : diff > swc ? 'fresh' : 'normal';
  return {
    status,
    latest: latest.score,
    baseline,
    sd: s,
    swc,
    diffPct: (diff / baseline) * 100,
    z: diff / s,
    baselineSessions: window.length,
  };
}

/** Readiness for each of the last `n` sessions (for a small trend strip). */
export function readinessTrend(sessions: Session[], n = 7): { start: string; r: Readiness }[] {
  const out: { start: string; r: Readiness }[] = [];
  for (let i = Math.max(4, sessions.length - n); i <= sessions.length; i++) {
    const r = readiness(sessions.slice(0, i));
    if (r) out.push({ start: sessions[i - 1].start, r });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trends, rolling averages, projections
// ---------------------------------------------------------------------------

/** Trailing mean of the last `k` values for each point. */
export function rolling(values: number[], k = 5): number[] {
  return values.map((_, i) => mean(values.slice(Math.max(0, i - k + 1), i + 1)));
}

/** Least-squares line y = a + b·t (t in days). */
export function linearTrend(points: { t: number; y: number }[]): { a: number; b: number } | null {
  if (points.length < 3) return null;
  const mt = mean(points.map((p) => p.t));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.y - my);
    den += (p.t - mt) ** 2;
  }
  if (!den) return null;
  const b = num / den;
  return { a: my - b * mt, b };
}

export interface GoalProgress {
  current: number;
  target: number;
  /** 0–1 of the way from the first session score to the target. */
  fraction: number;
  /** Change per week from the trend over the last 60 days. */
  perWeek: number | null;
  /** Date the trend reaches the target, if it's heading there. */
  projected: string | null;
  onTrack: boolean | null;
  reached: boolean;
}

export function goalProgress(sessions: Session[], target: number, by: string | null, now = Date.now()): GoalProgress | null {
  if (!sessions.length) return null;
  const current = Math.max(...sessions.map((s) => s.best));
  const start = sessions[0].score;
  const reached = current >= target;
  const recent = sessions.filter((s) => now - Date.parse(s.start) <= 60 * 86_400_000);
  const day = 86_400_000;
  const trend = linearTrend(recent.map((s) => ({ t: Date.parse(s.start) / day, y: s.score })));
  let projected: string | null = null;
  if (trend && trend.b > 0 && !reached) {
    const tDays = (target - trend.a) / trend.b;
    if (isFinite(tDays)) projected = new Date(tDays * day).toISOString();
  }
  const onTrack = reached ? true : by && projected ? Date.parse(projected) <= Date.parse(by) : by ? false : null;
  return {
    current,
    target,
    fraction: Math.max(0, Math.min(1, target === start ? 1 : (current - start) / (target - start))),
    perWeek: trend ? trend.b * 7 : null,
    projected,
    onTrack,
    reached,
  };
}

// ---------------------------------------------------------------------------
// Personal records and milestones
// ---------------------------------------------------------------------------

/** Is this jump a new best for its type (compared with jumps saved before it)? */
export function isPersonalRecord(records: JumpRecord[], r: JumpRecord, metric: Metric = 'heightCm'): boolean {
  const v = metricOf(r, metric);
  if (v === undefined) return false;
  const earlier = records.filter((x) => x.type === r.type && x.id !== r.id && x.date < r.date);
  if (!earlier.length) return false; // the first jump isn't a "record"
  return earlier.every((x) => (metricOf(x, metric) ?? -Infinity) < v);
}

/** Round-number heights crossed for the first time by this jump (every 5 cm, or every 2 in). */
export function milestonesCrossed(records: JumpRecord[], r: JumpRecord, units: 'cm' | 'in'): number[] {
  const step = units === 'in' ? 2 * 2.54 : 5;
  const before = Math.max(
    0,
    ...records.filter((x) => x.type === r.type && x.id !== r.id && x.date < r.date).map((x) => x.heightCm),
  );
  const out: number[] = [];
  for (let m = Math.ceil((before + 1e-9) / step) * step; m <= r.heightCm + 1e-9; m += step) {
    if (m > before) out.push(Math.round((units === 'in' ? m / 2.54 : m) * 10) / 10);
  }
  return before === 0 ? out.slice(-1) : out;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagStat {
  tag: string;
  withMean: number;
  withoutMean: number;
  nWith: number;
  nWithout: number;
  diffPct: number;
}

/** How each tag relates to jump height (mean with vs without), for tags used 2+ times. */
export function tagStats(records: JumpRecord[], metric: Metric = 'heightCm'): TagStat[] {
  const tags = new Map<string, number>();
  records.forEach((r) => r.tags?.forEach((t) => tags.set(t, (tags.get(t) ?? 0) + 1)));
  const out: TagStat[] = [];
  for (const [tag, n] of tags) {
    if (n < 2) continue;
    const w = records.filter((r) => r.tags?.includes(tag)).map((r) => metricOf(r, metric)).filter((v): v is number => v !== undefined);
    const wo = records.filter((r) => !r.tags?.includes(tag)).map((r) => metricOf(r, metric)).filter((v): v is number => v !== undefined);
    if (w.length < 2 || wo.length < 2) continue;
    const a = mean(w);
    const b = mean(wo);
    out.push({ tag, withMean: a, withoutMean: b, nWith: w.length, nWithout: wo.length, diffPct: ((a - b) / b) * 100 });
  }
  return out.sort((x, y) => Math.abs(y.diffPct) - Math.abs(x.diffPct));
}

// ---------------------------------------------------------------------------
// Validation against another device (Bland–Altman)
// ---------------------------------------------------------------------------

export interface Agreement {
  n: number;
  /** Mean of (app − reference), cm. Positive = app reads higher. */
  bias: number;
  sdDiff: number;
  loaLow: number;
  loaHigh: number;
  /** Pearson correlation. */
  r: number | null;
  /** Mean absolute percentage difference. */
  mape: number;
}

export function agreement(records: JumpRecord[]): Agreement | null {
  const pairs = records
    .filter((r) => r.reference && isFinite(r.reference.heightCm) && r.reference.heightCm > 0)
    .map((r) => ({ app: r.heightCm, ref: r.reference!.heightCm }));
  if (pairs.length < 2) return null;
  const diffs = pairs.map((p) => p.app - p.ref);
  const bias = mean(diffs);
  const s = sd(diffs);
  const ma = mean(pairs.map((p) => p.app));
  const mr = mean(pairs.map((p) => p.ref));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pairs) {
    sxy += (p.app - ma) * (p.ref - mr);
    sxx += (p.app - ma) ** 2;
    syy += (p.ref - mr) ** 2;
  }
  return {
    n: pairs.length,
    bias,
    sdDiff: s,
    loaLow: bias - 1.96 * s,
    loaHigh: bias + 1.96 * s,
    r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null,
    mape: mean(pairs.map((p) => Math.abs(p.app - p.ref) / p.ref)) * 100,
  };
}
