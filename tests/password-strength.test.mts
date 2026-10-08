import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength } from '../src/app/core/password-strength.ts';

test('weak passwords are refused', () => {
  for (const pw of ['password', 'Password123', 'qwerty123', '12345678', 'juventus', 'aaaaaaaaaa', 'qwertyuiop1']) {
    assert.equal(passwordStrength(pw).ok, false, pw);
  }
});

test('personal details are refused', () => {
  const s = passwordStrength('aldo.jumps!2026', ['aldo.jumps', 'aldogordoni@gmail.com']);
  assert.equal(s.ok, false);
  assert.match(s.hint!, /name/);
});

test('reasonable passwords pass and long phrases score highest', () => {
  assert.equal(passwordStrength('Tb7#kq9Lm2').ok, true);
  const phrase = passwordStrength('orange-cliff-bicycle-river');
  assert.equal(phrase.ok, true);
  assert.ok(phrase.score >= 3, `score ${phrase.score}`);
});
