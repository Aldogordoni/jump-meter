import { Injectable, computed, effect, signal } from '@angular/core';
import { JumpRecord, JumpType, Units } from './jump-math';
import type { ActivePlan } from './plans';
import type { SessionScoreMode } from './insights';
import type { Sex } from './norms';

export interface Settings {
  massKg: number | null;
  defaultType: JumpType;
  units: Units;
  /** Last box height used for drop jumps, in cm. */
  boxCm: number | null;
  /** Standing height, used to check the frame rate from the jump's motion. */
  statureCm: number | null;
  /** For reference ranges. */
  sex: Sex | null;
  /** How a session is scored: its best jump, or the mean of its best three. */
  sessionScore: SessionScoreMode;
  /** Jump type used for the readiness check. */
  readinessType: JumpType;
  goals: Goal[];
  plan: ActivePlan | null;
  /** Tags offered when saving, on top of the built-in ones. */
  customTags: string[];
  /** Vibrate / beep when a jump is detected. */
  haptics: boolean;
  /** First-run guide has been seen. */
  onboarded: boolean;
  /** Size of saved clips. */
  clipQuality: 'high' | 'standard';
  /** Delete clips of jumps older than this many months (null = keep forever). */
  clipRetentionMonths: number | null;
}

export interface Goal {
  id: string;
  type: JumpType;
  metric: 'heightCm' | 'rsi' | 'rsiMod';
  target: number;
  /** ISO date, optional. */
  by: string | null;
  createdAt: string;
}

const HISTORY_KEY = 'jump-meter.history.v1';
const SETTINGS_KEY = 'jump-meter.settings.v1';

const DEFAULT_SETTINGS: Settings = {
  massKg: null,
  defaultType: 'CMJ',
  units: 'cm',
  boxCm: null,
  statureCm: null,
  sex: null,
  sessionScore: 'best',
  readinessType: 'CMJ',
  goals: [],
  plan: null,
  customTags: [],
  haptics: true,
  onboarded: false,
  clipQuality: 'high',
  clipRetentionMonths: null,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...(fallback as object), ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked – keep working in memory */
  }
}

@Injectable({ providedIn: 'root' })
export class StoreService {
  readonly history = signal<JumpRecord[]>(loadArray<JumpRecord>(HISTORY_KEY));
  readonly settings = signal<Settings>(load(SETTINGS_KEY, DEFAULT_SETTINGS));

  /** Newest first. */
  readonly sorted = computed(() => [...this.history()].sort((a, b) => b.date.localeCompare(a.date)));

  constructor() {
    effect(() => save(HISTORY_KEY, this.history()));
    effect(() => save(SETTINGS_KEY, this.settings()));
  }

  add(record: Omit<JumpRecord, 'id'>): JumpRecord {
    const full: JumpRecord = { ...record, id: uuid(), synced: false };
    this.history.update((h) => [...h, full]);
    this.listeners.forEach((l) => l({ kind: 'add', record: full }));
    return full;
  }

  /** Change listeners (the cloud sync subscribes here). */
  private readonly listeners: ((e: { kind: 'add' | 'restore'; record: JumpRecord }) => void)[] = [];
  onChange(fn: (e: { kind: 'add' | 'restore'; record: JumpRecord }) => void) {
    this.listeners.push(fn);
  }

  /** Replace or insert records by id (used by sync). */
  upsertMany(records: JumpRecord[]) {
    if (!records.length) return;
    const byId = new Map(this.history().map((r) => [r.id, r]));
    for (const r of records) byId.set(r.id, { ...byId.get(r.id), ...r });
    this.history.set([...byId.values()]);
  }

  removeIds(ids: Iterable<string>) {
    const drop = new Set(ids);
    if (drop.size) this.history.update((h) => h.filter((r) => !drop.has(r.id)));
  }

  patch(id: string, patch: Partial<JumpRecord>) {
    this.history.update((h) => h.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** User edit: change a jump's date and queue it for upload. */
  setDate(id: string, iso: string) {
    this.edit(id, { date: iso });
  }

  /** User edit of any fields; queues the jump for upload. */
  edit(id: string, patch: Partial<JumpRecord>) {
    this.patch(id, { ...patch, synced: false });
    const r = this.history().find((x) => x.id === id);
    if (r) this.listeners.forEach((l) => l({ kind: 'restore', record: r }));
  }

  remove(id: string) {
    this.history.update((h) => h.filter((r) => r.id !== id));
  }

  restore(record: JumpRecord) {
    this.history.update((h) => [...h, record]);
    this.listeners.forEach((l) => l({ kind: 'restore', record }));
  }

  updateSettings(patch: Partial<Settings>) {
    this.settings.update((s) => ({ ...s, ...patch }));
  }

  bestFor(type: JumpType): JumpRecord | undefined {
    return this.history()
      .filter((r) => r.type === type)
      .reduce<JumpRecord | undefined>((best, r) => (!best || r.heightCm > best.heightCm ? r : best), undefined);
  }

  exportJson(): string {
    return JSON.stringify({ app: 'jump-meter', version: 1, history: this.history(), settings: this.settings() }, null, 2);
  }

  /** Merge an exported file; returns how many new jumps were added. */
  importJson(text: string): number {
    const data = JSON.parse(text);
    const incoming: JumpRecord[] = Array.isArray(data) ? data : data.history;
    if (!Array.isArray(incoming)) throw new Error('No jump history found in that file.');
    return this.importRecords(incoming);
  }

  /** Add jumps from a backup that aren't here yet; returns how many were added. */
  importRecords(incoming: JumpRecord[]): number {
    const known = new Set(this.history().map((r) => r.id));
    const fresh = incoming.filter(
      (r) => r && typeof r.heightCm === 'number' && typeof r.date === 'string' && !known.has(r.id),
    );
    this.history.update((h) => [...h, ...fresh.map((r) => ({ ...r, synced: false, hasClip: false }))]);
    fresh.forEach((r) => this.listeners.forEach((l) => l({ kind: 'add', record: r })));
    return fresh.length;
  }
}
