import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupSessions, readiness, goalProgress, isPersonalRecord, milestonesCrossed, tagStats, agreement, sessionIdFor, rolling,
} from '../src/app/core/insights.ts';
import type { JumpRecord } from '../src/app/core/jump-math.ts';

let n = 0;
const jump = (date: string, heightCm: number, extra: Partial<JumpRecord> = {}): JumpRecord => ({
  id: `j${n++}`, date, heightCm, flightMs: 0, captureFps: 240, frames: 0, type: 'CMJ', method: 'manual', ...extra,
});

test('groups jumps into sessions by time gap and scores them', () => {
  const rs = [
    jump('2026-09-01T10:00:00Z', 40), jump('2026-09-01T10:02:00Z', 42), jump('2026-09-01T10:04:00Z', 38),
    jump('2026-09-03T18:00:00Z', 41),
  ];
  const best = groupSessions(rs, 'CMJ');
  assert.equal(best.length, 2);
  assert.equal(best[0].score, 42);
  assert.equal(best[0].jumps.length, 3);
  assert.ok(best[0].cv! > 4 && best[0].cv! < 6); // SD 2 / mean 40 = 5%
  const mean3 = groupSessions(rs, 'CMJ', 'heightCm', 'mean3');
  assert.equal(mean3[0].score, 40);
});

test('explicit session ids win over time gaps', () => {
  const rs = [jump('2026-09-01T10:00:00Z', 40, { sessionId: 'a' }), jump('2026-09-01T10:30:00Z', 41, { sessionId: 'b' })];
  assert.equal(groupSessions(rs, 'CMJ').length, 2);
  assert.equal(sessionIdFor(rs, '2026-09-01T10:35:00Z'), 'b');
  assert.equal(sessionIdFor(rs, '2026-09-02T10:35:00Z'), null);
});

test('readiness flags a clearly low day as fatigued and a normal day as normal', () => {
  const days = [40, 41, 40.5, 39.5, 40.2, 40.8];
  const base = days.map((h, i) => jump(`2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`, h));
  const low = readiness(groupSessions([...base, jump('2026-09-10T10:00:00Z', 37)], 'CMJ'))!;
  assert.equal(low.status, 'fatigued');
  assert.ok(low.diffPct < -6);
  const ok = readiness(groupSessions([...base, jump('2026-09-10T10:00:00Z', 40.4)], 'CMJ'))!;
  assert.equal(ok.status, 'normal');
  const hi = readiness(groupSessions([...base, jump('2026-09-10T10:00:00Z', 41.5)], 'CMJ'))!;
  assert.equal(hi.status, 'fresh');
  assert.equal(readiness(groupSessions(base.slice(0, 3), 'CMJ')), null);
});

test('goal projection follows the trend', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const rs = [0, 7, 14, 21, 28].map((d, i) => jump(new Date(now - (28 - d) * 86_400_000).toISOString(), 40 + i));
  const g = goalProgress(groupSessions(rs, 'CMJ'), 46, '2026-11-30T00:00:00Z', now)!;
  assert.equal(g.current, 44);
  assert.ok(Math.abs(g.perWeek! - 1) < 0.01);
  assert.equal(g.onTrack, true); // 2 cm to go at 1 cm/week → mid October
  assert.ok(g.projected! < '2026-10-20');
});

test('personal records and milestones', () => {
  const a = jump('2026-09-01T10:00:00Z', 38);
  const b = jump('2026-09-02T10:00:00Z', 41);
  const c = jump('2026-09-03T10:00:00Z', 40);
  const all = [a, b, c];
  assert.equal(isPersonalRecord(all, a), false);
  assert.equal(isPersonalRecord(all, b), true);
  assert.equal(isPersonalRecord(all, c), false);
  assert.deepEqual(milestonesCrossed(all, b, 'cm'), [40]);
  assert.deepEqual(milestonesCrossed(all, c, 'cm'), []);
});

test('tag comparison and device agreement', () => {
  const rs = [
    jump('2026-09-01T10:00:00Z', 42, { tags: ['warm-up'], reference: { heightCm: 41, device: 'mat' } }),
    jump('2026-09-02T10:00:00Z', 43, { tags: ['warm-up'], reference: { heightCm: 42.5, device: 'mat' } }),
    jump('2026-09-03T10:00:00Z', 38, { reference: { heightCm: 37, device: 'mat' } }),
    jump('2026-09-04T10:00:00Z', 39),
  ];
  const t = tagStats(rs)[0];
  assert.equal(t.tag, 'warm-up');
  assert.ok(t.diffPct > 10);
  const a = agreement(rs)!;
  assert.equal(a.n, 3);
  assert.ok(Math.abs(a.bias - 0.8333) < 0.01);
  assert.ok(a.r! > 0.99);
  assert.deepEqual(rolling([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);
});
