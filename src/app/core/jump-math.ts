export const G = 9.81;
export const CM_PER_IN = 2.54;

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

/** Reactive Strength Index for drop jumps: jump height (m) ÷ ground contact time (s). */
export function rsi(heightCm: number, contactSec: number): number {
  return heightCm / 100 / contactSec;
}

/** RSI-modified: jump height (m) ÷ time to take-off (s), from movement start to leaving the ground. */
export function rsiMod(heightCm: number, timeToTakeoffSec: number): number {
  return heightCm / 100 / timeToTakeoffSec;
}

export type Units = 'cm' | 'in';

export function toUnits(cm: number, units: Units): number {
  return units === 'in' ? cm / CM_PER_IN : cm;
}

export function fromUnits(value: number, units: Units): number {
  return units === 'in' ? value * CM_PER_IN : value;
}

export type JumpType =
  | 'CMJ'
  | 'CMJ + arms'
  | 'Squat jump'
  | 'Drop jump'
  | 'Single-leg L'
  | 'Single-leg R'
  | 'Approach'
  | 'Other';

export const JUMP_TYPES: JumpType[] = [
  'CMJ',
  'CMJ + arms',
  'Squat jump',
  'Drop jump',
  'Single-leg L',
  'Single-leg R',
  'Approach',
  'Other',
];

export const JUMP_TYPE_HINT: Record<JumpType, string> = {
  CMJ: 'Hands on hips, quick dip and jump.',
  'CMJ + arms': 'Dip and jump with a full arm swing.',
  'Squat jump': 'Hold a half squat for 2 s, then jump without dipping.',
  'Drop jump': 'Step off a box, land and rebound as fast and high as you can.',
  'Single-leg L': 'Countermovement jump off the left leg only.',
  'Single-leg R': 'Countermovement jump off the right leg only.',
  Approach: 'Run-up jump, like a basketball or volleyball take-off.',
  Other: 'Anything else.',
};

export const isDropJump = (t: JumpType) => t === 'Drop jump';

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
  /** Drop jump: ground contact time between box landing and take-off. */
  contactMs?: number;
  /** Drop jump: RSI = height (m) / contact (s). */
  rsi?: number;
  /** Drop jump: box height. */
  boxCm?: number;
  /** Time from movement start to take-off. */
  timeToTakeoffMs?: number;
  /** RSI-modified = height (m) / time to take-off (s). */
  rsiMod?: number;
  /** Local bookkeeping: saved to the cloud. */
  synced?: boolean;
  /** The cloud has a video clip for this jump. */
  hasClip?: boolean;
}
