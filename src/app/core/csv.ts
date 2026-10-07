import type { JumpRecord } from './jump-math';

const COLUMNS: [string, (r: JumpRecord) => unknown][] = [
  ['date', (r) => r.date],
  ['type', (r) => r.type],
  ['height_cm', (r) => r.heightCm],
  ['height_in', (r) => round(r.heightCm / 2.54, 1)],
  ['flight_ms', (r) => r.flightMs],
  ['contact_ms', (r) => r.contactMs],
  ['rsi', (r) => r.rsi],
  ['time_to_takeoff_ms', (r) => r.timeToTakeoffMs],
  ['rsi_mod', (r) => r.rsiMod],
  ['box_cm', (r) => r.boxCm],
  ['distance_cm', (r) => r.distanceCm],
  ['reach_cm', (r) => r.reachCm],
  ['depth_cm', (r) => r.kinematics?.depthCm],
  ['eccentric_ms', (r) => r.kinematics?.eccentricMs],
  ['concentric_ms', (r) => r.kinematics?.concentricMs],
  ['peak_velocity_ms', (r) => r.kinematics?.peakVelocity],
  ['landing_flagged', (r) => (r.posture ? r.posture.flagged : undefined)],
  ['arm_swing', (r) => r.armSwing],
  ['hops', (r) => r.hops?.length],
  ['confidence', (r) => r.confidence?.level],
  ['capture_fps', (r) => r.captureFps],
  ['method', (r) => r.method],
  ['session', (r) => r.sessionId],
  ['tags', (r) => r.tags?.join('; ')],
  ['reference_cm', (r) => r.reference?.heightCm],
  ['reference_device', (r) => r.reference?.device],
  ['note', (r) => r.note],
];

function round(n: number, d: number) {
  return Math.round(n * 10 ** d) / 10 ** d;
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Spreadsheet-friendly CSV, oldest first. */
export function toCsv(records: JumpRecord[]): string {
  const rows = [...records].sort((a, b) => a.date.localeCompare(b.date));
  return [COLUMNS.map(([h]) => h).join(','), ...rows.map((r) => COLUMNS.map(([, f]) => cell(f(r))).join(','))].join('\n');
}
