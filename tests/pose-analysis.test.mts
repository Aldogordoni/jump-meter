import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  metresPerUnit, postureCheck, detectArmSwing, kinematics, confidenceOf, findHops, hopsToStats, best5Rsi, kneeAngle,
} from '../src/app/core/pose-analysis.ts';
import type { FootSample } from '../src/app/core/flight-detect.ts';

type Pt = [number, number, number];

/** Side-on body: hip above knee above ankle, knee pushed forward by `bend` (0 = straight). */
function body(frame: number, footY: number, bend = 0, hipDrop = 0, wristY?: number): FootSample {
  const ankle: Pt = [0.5, footY - 0.02, 1];
  const shin = 0.22;
  const thigh = 0.22;
  // Knee angle from bend: place the knee forward and the hip back down.
  const theta = (bend * Math.PI) / 180 / 2;
  const knee: Pt = [ankle[0] + Math.sin(theta) * shin, ankle[1] - Math.cos(theta) * shin, 1];
  const hip: Pt = [knee[0] - Math.sin(theta) * thigh, knee[1] - Math.cos(theta) * thigh + hipDrop, 1];
  const shoulder: Pt = [hip[0], hip[1] - 0.25, 1];
  const wrist: Pt = [hip[0], wristY ?? hip[1], 1];
  return {
    frame,
    footY,
    legLen: ankle[1] - hip[1],
    hipY: hip[1],
    noseY: shoulder[1] - 0.1,
    heelY: footY,
    pts: {
      hipL: hip, hipR: hip, kneeL: knee, kneeR: knee, ankleL: ankle, ankleR: ankle,
      shoulderL: shoulder, shoulderR: shoulder, wristL: wrist, wristR: wrist,
      heelL: [0.48, footY, 0.9], heelR: [0.48, footY, 0.9], toeL: [0.55, footY, 0.9], toeR: [0.55, footY, 0.9],
    },
  };
}

test('metres per unit from standing body size', () => {
  const s = body(0, 0.9);
  const S = metresPerUnit([s, s, s], 1.8)!;
  // nose to heel ≈ 0.93 × 1.8 m
  assert.ok(Math.abs((s.heelY! - s.noseY!) * S - 1.8 * 0.935) < 1e-9);
});

test('knee angle reads ~180° straight and less when bent', () => {
  assert.ok(kneeAngle(body(0, 0.9, 0), 1)! > 178);
  const bent = kneeAngle(body(0, 0.9, 60), 1)!;
  assert.ok(bent > 110 && bent < 130, `bent ${bent}`);
});

test('posture: straight landing passes, deep bent-knee landing is flagged', () => {
  const S = 2.5;
  const takeoff = body(10, 0.9, 5);
  const good = postureCheck(takeoff, body(40, 0.9, 8), 0.5, S, 1)!;
  assert.equal(good.flagged, false);
  assert.ok(good.inflationCm < 1);
  const bad = postureCheck(takeoff, body(40, 0.9, 70), 0.5, S, 1)!;
  assert.equal(bad.flagged, true);
  assert.ok(bad.kneeTakeoff - bad.kneeLanding > 15);
  assert.ok(bad.inflationCm > 1.5, `inflation ${bad.inflationCm}`);
});

test('arm swing: wrists above shoulders vs hands on hips', () => {
  const swing = [body(1, 0.9, 30, 0, 0.12), body(2, 0.9, 20, 0, 0.08)];
  assert.equal(detectArmSwing(swing), true);
  const hips = [body(1, 0.9, 30), body(2, 0.9, 20)];
  assert.equal(detectArmSwing(hips), false);
  assert.equal(detectArmSwing([]), null);
});

test('kinematics: countermovement depth and phase times', () => {
  const fps = 240;
  const S = 2;
  const samples: FootSample[] = [];
  // Stand 0–48, dip 0.15 units (30 cm) by frame 120, push back up to take off at 200.
  for (let f = 0; f <= 200; f += 4) {
    let drop = 0;
    if (f > 48 && f <= 120) drop = (0.15 * (f - 48)) / 72;
    else if (f > 120) drop = 0.15 * (1 - (f - 120) / 80);
    samples.push(body(f, 0.9, 0, drop));
  }
  const k = kinematics({
    samples, movementStart: 48, takeoffFrame: 200, timeOf: (f) => f / fps, metresPerUnit: S, flightSec: 0.55, massKg: 80,
  });
  assert.equal(k.depthCm, 30);
  assert.equal(k.eccentricMs, 300);
  assert.equal(k.concentricMs, 333);
  assert.ok(Math.abs(k.takeoffVelocity - 2.7) < 0.01);
  assert.equal(k.momentum, 216);
  assert.ok(k.peakVelocity! > 0.8 && k.peakVelocity! < 1.2, `peak ${k.peakVelocity}`);
  // No dip → no phase data.
  const flat = kinematics({ samples: samples.map((s) => ({ ...s, hipY: 0.5 })), movementStart: null, takeoffFrame: 200, timeOf: (f) => f / fps, metresPerUnit: S, flightSec: 0.5, massKg: null });
  assert.equal(flat.depthCm, null);
});

test('confidence drops with low fps and bad landings', () => {
  const hi = confidenceOf({ fps: 240, auto: true, subFrame: true, fpsCheck: 'agrees', poseVisibility: 0.9, postureFlagged: false, implausible: false });
  assert.equal(hi.level, 'high');
  const lo = confidenceOf({ fps: 30, auto: false, subFrame: false, fpsCheck: 'suggest', poseVisibility: 0.4, postureFlagged: true, implausible: false });
  assert.equal(lo.level, 'low');
  assert.ok(lo.reasons.length >= 3);
});

test('repeated hops: finds each flight and scores the best five', () => {
  const fps = 240;
  const floor = 0.9;
  const dense: FootSample[] = [];
  // 6 hops: 200 ms contact, then flight of 400 ms (peak ≈ 0.2 units above floor).
  let f = 0;
  for (; f < 120; f++) dense.push(body(f, floor));
  for (let hop = 0; hop < 6; hop++) {
    const flight = 96; // frames
    for (let k = 0; k < flight; k++) {
      const t = (k + 0.5) / flight;
      dense.push(body(f++, floor - 0.8 * t * (1 - t)));
    }
    for (let k = 0; k < 48; k++) dense.push(body(f++, floor));
  }
  const events = findHops(dense, floor, 0.01);
  assert.equal(events.length, 6);
  const hops = hopsToStats(events, (a, b) => (b - a) / fps);
  for (const h of hops) assert.ok(Math.abs(h.flightMs - 400) <= 10, `flight ${h.flightMs}`);
  assert.equal(hops[0].contactMs, null);
  assert.ok(Math.abs(hops[1].contactMs! - 200) <= 10, `contact ${hops[1].contactMs}`);
  const best = best5Rsi(hops)!;
  // h = 9.81·0.4²/8 = 19.6 cm; RSI ≈ 0.196 / 0.2 ≈ 0.98
  assert.ok(Math.abs(best.rsi - 0.98) < 0.06, `rsi ${best.rsi}`);
  assert.ok(Math.abs(best.heightCm - 19.6) < 1);
});
