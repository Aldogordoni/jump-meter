import { Injectable, computed, effect, signal } from '@angular/core';
import { JumpRecord, JumpType } from './jump-math';

export interface Settings {
  massKg: number | null;
  defaultType: JumpType;
}

const HISTORY_KEY = 'jump-meter.history.v1';
const SETTINGS_KEY = 'jump-meter.settings.v1';

const DEFAULT_SETTINGS: Settings = { massKg: null, defaultType: 'CMJ' };

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
    const full: JumpRecord = { ...record, id: crypto.randomUUID?.() ?? String(Date.now()) };
    this.history.update((h) => [...h, full]);
    return full;
  }

  remove(id: string) {
    this.history.update((h) => h.filter((r) => r.id !== id));
  }

  restore(record: JumpRecord) {
    this.history.update((h) => [...h, record]);
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
    const known = new Set(this.history().map((r) => r.id));
    const fresh = incoming.filter(
      (r) => r && typeof r.heightCm === 'number' && typeof r.date === 'string' && !known.has(r.id),
    );
    this.history.update((h) => [...h, ...fresh]);
    return fresh.length;
  }
}
