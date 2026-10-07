import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framingOf, isStill, JumpWatcher } from '../src/app/core/framing.ts';
import type { FootSample } from '../src/app/core/flight-detect.ts';

function person(footY: number, noseY: number, hipX = 0.5, feetVis = 0.9, frame = 0): FootSample {
  const hipY = (footY + noseY) / 2;
  return {
    frame, footY, noseY, heelY: footY, hipY, legLen: footY - hipY,
    pts: {
      hipL: [hipX, hipY, 1], hipR: [hipX, hipY, 1],
      heelL: [hipX, footY, feetVis], heelR: [hipX, footY, feetVis], toeL: [hipX + 0.03, footY, feetVis], toeR: [hipX + 0.03, footY, feetVis],
    },
  };
}

test('framing guidance', () => {
  assert.equal(framingOf(null).issue, 'none');
  assert.equal(framingOf(person(0.85, 0.25)).issue, 'good');
  assert.equal(framingOf(person(0.99, 0.3)).issue, 'feet');
  assert.equal(framingOf(person(0.85, 0.25, 0.5, 0.2)).issue, 'feet');
  assert.equal(framingOf(person(0.9, 0.02)).issue, 'head');
  assert.equal(framingOf(person(0.95, 0.1)).issue, 'close');
  assert.equal(framingOf(person(0.6, 0.4)).issue, 'far');
  assert.equal(framingOf(person(0.85, 0.25, 0.9)).issue, 'centre');
});

test('stillness', () => {
  const still = [0, 1, 2, 3, 4].map((i) => person(0.85 + (i % 2) * 0.002, 0.25));
  assert.equal(isStill(still, 0.3), true);
  const moving = [0, 1, 2, 3, 4].map((i) => person(0.85 - i * 0.03, 0.25 - i * 0.03));
  assert.equal(isStill(moving, 0.3), false);
});

test('jump watcher: stand, jump, land, settle', () => {
  const w = new JumpWatcher(1000);
  let t = 0;
  const feed = (footY: number, n: number) => {
    let st = w.state;
    for (let i = 0; i < n; i++) st = w.push(person(footY, footY - 0.6), (t += 150));
    return st;
  };
  assert.equal(feed(0.85, 8), 'ground');
  assert.equal(feed(0.7, 3), 'air');
  assert.equal(feed(0.85, 2), 'landed');
  assert.equal(feed(0.85, 6), 'done');
  assert.equal(w.flights, 1);
});

test('jump watcher: stepping off a box is not a jump; the rebound is', () => {
  const w = new JumpWatcher(1000);
  let t = 0;
  const feed = (footY: number, n: number) => {
    let st = w.state;
    for (let i = 0; i < n; i++) st = w.push(person(footY, footY - 0.5), (t += 150));
    return st;
  };
  assert.equal(feed(0.7, 6), 'ground'); // on the box
  assert.equal(feed(0.85, 2), 'ground'); // stepped down to the floor
  assert.equal(feed(0.72, 2), 'air'); // rebound
  assert.equal(feed(0.85, 8), 'done');
});
