export const G = 9.81;

/** Jump height (m) from flight time (s): h = g·t² / 8. */
export function heightFromFlight(flightSec: number): number {
  return (G * flightSec * flightSec) / 8;
}

/** Take-off velocity (m/s): v = g·t / 2. */
export function takeoffVelocity(flightSec: number): number {
  return (G * flightSec) / 2;
}

/**
 * Peak power estimate (W) – Sayers et al. (1999) equation for
 * countermovement/squat jumps: P = 60.7·h(cm) + 45.3·mass(kg) − 2055.
 */
export function sayersPower(heightCm: number, massKg: number): number {
  return 60.7 * heightCm + 45.3 * massKg - 2055;
}

/**
 * Uncertainty (± cm) from frame timing. Each mark can be off by up to half a
 * frame, so the flight time is off by up to one frame period; dh = g·t·dt / 4.
 */
export function heightUncertaintyCm(flightSec: number, captureFps: number): number {
  const dt = 1 / captureFps;
  return ((G * flightSec * dt) / 4) * 100;
}

/**
 * Flight time from frame marks.
 * `firstAir` = first frame with both feet off the ground,
 * `firstGround` = first frame touching the ground again.
 * Frames are counted in the file, but each one represents 1/captureFps of real time.
 */
export function flightFromFrames(firstAir: number, firstGround: number, captureFps: number): number {
  return (firstGround - firstAir) / captureFps;
}

export type JumpType = 'CMJ' | 'CMJ + arms' | 'Squat jump' | 'Approach' | 'Other';
export const JUMP_TYPES: JumpType[] = ['CMJ', 'CMJ + arms', 'Squat jump', 'Approach', 'Other'];

export interface JumpRecord {
  id: string;
  date: string; // ISO
  heightCm: number;
  flightMs: number;
  captureFps: number;
  frames: number;
  type: JumpType;
  method: 'manual' | 'auto' | 'auto-adjusted';
  note?: string;
}
