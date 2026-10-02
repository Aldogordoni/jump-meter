import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { StoreService } from '../core/store.service';
import { JUMP_TYPES, JumpRecord, JumpType, toUnits } from '../core/jump-math';
import { HeightPipe, formatNumber } from '../core/height.pipe';
import { ChartPoint, ProgressChart } from '../shared/progress-chart';
import { clipStore, StoredClip } from '../core/clip-store';
import { CloudService } from '../core/cloud.service';

type MetricKey = 'height' | 'rsi' | 'contact' | 'rsiMod' | 'ttt';

interface Metric {
  key: MetricKey;
  name: string;
  get: (r: JumpRecord) => number | undefined;
  higherIsBetter: boolean;
}

@Component({
  selector: 'app-history',
  imports: [DatePipe, DecimalPipe, RouterLink, ProgressChart, HeightPipe],
  template: `
    <h1>History</h1>

    @if (!store.history().length) {
      <p>No jumps saved yet. Measure one and tap <strong>Save</strong>, and it shows up here with your progress over time.</p>
      <a class="btn primary" routerLink="/measure">Measure a jump</a>
    } @else {
      <div class="chips" role="tablist" aria-label="Jump type">
        @for (t of typesInUse(); track t) {
          <button role="tab" type="button" [attr.aria-selected]="t === type()" [class.on]="t === type()" (click)="chosen.set(t)">
            {{ t }}
          </button>
        }
      </div>

      <div class="pb">
        <div>
          <span class="label">Best height</span>
          <span class="num v red">{{ best()?.heightCm | height: 'value' }}<small>{{ units() }}</small></span>
        </div>
        <div>
          <span class="label">Last 5 average</span>
          <span class="num v">{{ recentAvg() | height: 'value' }}<small>{{ units() }}</small></span>
        </div>
        @if (bestRsi() !== null) {
          <div>
            <span class="label">Best RSI</span>
            <span class="num v">{{ bestRsi() | number: '1.2-2' }}</span>
          </div>
        } @else if (bestRsiMod() !== null) {
          <div>
            <span class="label">Best RSI-mod</span>
            <span class="num v">{{ bestRsiMod() | number: '1.2-2' }}</span>
          </div>
        } @else {
          <div>
            <span class="label">Jumps</span>
            <span class="num v">{{ filtered().length }}</span>
          </div>
        }
      </div>

      @if (asymmetry(); as a) {
        <div class="asym">
          <div>
            <span class="label">Left best</span>
            <span class="num">{{ a.left | height }}</span>
          </div>
          <div>
            <span class="label">Right best</span>
            <span class="num">{{ a.right | height }}</span>
          </div>
          <div>
            <span class="label">Asymmetry</span>
            <span class="num" [class.flag]="a.pct >= 10">{{ a.pct | number: '1.0-0' }}%</span>
            <span class="small muted">{{ a.weaker === 'left' ? 'Left' : 'Right' }} is weaker</span>
          </div>
          <p class="small muted">Over 10–15% is usually worth working on.</p>
        </div>
      }

      @if (metrics().length > 1) {
        <div class="chips small-chips" role="tablist" aria-label="Chart">
          @for (m of metrics(); track m.key) {
            <button role="tab" type="button" [attr.aria-selected]="m.key === metric().key" [class.on]="m.key === metric().key" (click)="chosenMetric.set(m.key)">
              {{ m.name }}
            </button>
          }
        </div>
      }

      @if (chartPoints().length >= 2) {
        <app-progress-chart
          [points]="chartPoints()"
          [higherIsBetter]="metric().higherIsBetter"
          [metricName]="metric().name"
        />
      }

      <ul class="list">
        @for (r of filtered(); track r.id) {
          <li>
            <div class="h num">{{ r.heightCm | height: 'value' }} <small>{{ units() }}</small></div>
            <div class="meta">
              <span>{{ r.date | date: 'EEE d MMM yyyy, HH:mm' }}</span>
              @if (r.rsi !== undefined) {
                <span class="stat">RSI {{ r.rsi | number: '1.2-2' }}, contact {{ r.contactMs | number: '1.0-0' }} ms@if (r.boxCm) {, {{ r.boxCm | height: 'full' : 0 }} box}</span>
              }
              @if (r.rsiMod !== undefined) {
                <span class="stat">RSI-mod {{ r.rsiMod | number: '1.2-2' }}, {{ r.timeToTakeoffMs | number: '1.0-0' }} ms to take-off</span>
              }
              <span class="muted">
                {{ r.flightMs | number: '1.0-0' }} ms flight, {{ r.captureFps }} fps, {{ methodLabel(r) }}
              </span>
              @if (r.note) {
                <span class="note">{{ r.note }}</span>
              }
              @if (clipIds().has(r.id) || r.hasClip) {
                <button class="thumb" type="button" (click)="openClip(r)" [disabled]="opening() === r.id">
                  @if (posters()[r.id]; as src) {
                    <img [src]="src" alt="" />
                  }
                  <span>{{ opening() === r.id ? 'Downloading clip…' : 'Watch clip' }}</span>
                </button>
              }
            </div>
            <button class="btn ghost del" type="button" (click)="remove(r)" [attr.aria-label]="'Delete jump of ' + (r.heightCm | height)">
              Delete
            </button>
          </li>
        }
      </ul>
    }

    @if (viewing(); as v) {
      <div class="viewer" role="dialog" aria-modal="true" aria-label="Jump clip" (click)="closeClip()">
        <div class="viewer-box" (click)="$event.stopPropagation()">
          <video [src]="v.url" controls autoplay loop muted playsinline></video>
          <div class="viewer-actions">
            @if (canShare()) {
              <button class="btn primary" type="button" (click)="shareClip()">Share or save</button>
            }
            <a class="btn" [href]="v.url" [download]="v.fileName">Download</a>
            <button class="btn ghost" type="button" (click)="closeClip()">Close</button>
          </div>
        </div>
      </div>
    }

    @if (undo(); as u) {
      <div class="toast" role="status">
        Deleted {{ u.heightCm | height }} jump.
        <button class="btn ghost" type="button" (click)="restore()">Undo</button>
      </div>
    }
  `,
  styles: `
    .chips {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      margin-bottom: 16px;
      padding-bottom: 2px;
      button {
        flex: none;
        min-height: 40px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1.5px solid var(--line);
        background: var(--surface);
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      button.on {
        background: var(--ink);
        color: var(--paper);
        border-color: var(--ink);
      }
    }
    .small-chips {
      margin-bottom: 8px;
      button {
        min-height: 34px;
        font-size: 0.88rem;
        padding: 0 12px;
      }
      button.on {
        background: var(--blue);
        border-color: var(--blue);
        color: var(--blue-ink);
      }
    }
    .label {
      display: block;
      font-size: 0.82rem;
      color: var(--ink-soft);
    }
    .pb {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 16px;
      .v {
        font-size: 2rem;
        font-weight: 700;
        line-height: 1;
      }
      .red {
        color: var(--red);
      }
      small {
        font-size: 0.9rem;
        margin-left: 2px;
        color: var(--ink-soft);
      }
    }
    .asym {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      padding: 12px;
      margin-bottom: 16px;
      background: var(--surface);
      border-radius: var(--r-lg);
      .num {
        font-size: 1.25rem;
        font-weight: 700;
      }
      .flag {
        color: var(--red);
      }
      p {
        grid-column: 1 / -1;
        margin: 0;
      }
    }
    .small {
      font-size: 0.85rem;
    }
    .list {
      list-style: none;
      padding: 0;
      margin: 16px 0 0;
      li {
        display: grid;
        grid-template-columns: 5.2rem 1fr auto;
        gap: 10px;
        align-items: center;
        padding: 10px 0;
        border-top: 1px solid var(--line);
      }
      .h {
        font-size: 1.6rem;
        font-weight: 700;
        small {
          font-size: 0.85rem;
          color: var(--ink-soft);
        }
      }
      .meta {
        display: grid;
        font-size: 0.88rem;
        min-width: 0;
      }
      .stat {
        font-weight: 600;
      }
      .note {
        font-style: italic;
      }
      .del {
        color: var(--red);
        padding-inline: 0.6em;
      }
    }
    .thumb {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--blue);
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      img {
        width: 64px;
        height: 40px;
        object-fit: cover;
        border-radius: var(--r-sm);
        background: #000;
      }
    }
    .viewer {
      position: fixed;
      inset: 0;
      z-index: 20;
      background: rgba(10, 14, 24, 0.85);
      display: grid;
      place-items: center;
      padding: 16px;
    }
    .viewer-box {
      width: min(100%, 720px);
      display: grid;
      gap: 10px;
      video {
        width: 100%;
        max-height: 70vh;
        background: #000;
        border-radius: var(--r-lg);
      }
    }
    .viewer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      .btn {
        color: #fff;
        border-color: #fff;
      }
      .btn.primary {
        border-color: var(--blue);
      }
    }
    .toast {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: calc(72px + env(safe-area-inset-bottom));
      max-width: 520px;
      margin: 0 auto;
      background: var(--ink);
      color: var(--paper);
      border-radius: var(--r-lg);
      padding: 6px 6px 6px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      .btn {
        color: var(--paper);
      }
    }
  `,
})
export class History implements OnDestroy {
  protected readonly store = inject(StoreService);
  private readonly cloud = inject(CloudService);
  protected readonly opening = signal<string | null>(null);
  private readonly posterRequested = new Set<string>();
  protected readonly clipIds = signal<Set<string>>(new Set());
  protected readonly posters = signal<Record<string, string>>({});
  protected readonly viewing = signal<{ url: string; fileName: string; clip: StoredClip } | null>(null);
  protected readonly canShare = signal(typeof navigator !== 'undefined' && !!navigator.canShare);
  private readonly pendingClipDeletes = new Set<string>();

  constructor() {
    this.refreshClips();
    // Load poster thumbnails for the jumps on screen.
    effect(() => {
      const ids = this.clipIds();
      const have = this.posters();
      const remote: string[] = [];
      for (const r of this.filtered()) {
        if (have[r.id] || this.posterRequested.has(r.id)) continue;
        if (ids.has(r.id)) {
          this.posterRequested.add(r.id);
          clipStore.get(r.id).then((c) => {
            if (c && c.poster.size) this.posters.update((p) => ({ ...p, [r.id]: URL.createObjectURL(c.poster) }));
          });
        } else if (r.hasClip && this.cloud.signedIn()) {
          this.posterRequested.add(r.id);
          remote.push(r.id);
        }
      }
      // Clips saved from another device: thumbnails come from the cloud.
      if (remote.length) {
        this.cloud
          .posterUrls(remote)
          .then((urls) => this.posters.update((p) => ({ ...p, ...urls })))
          .catch(() => undefined);
      }
    });
  }

  ngOnDestroy() {
    Object.values(this.posters()).forEach((u) => URL.revokeObjectURL(u));
    this.closeClip();
    this.flushClipDeletes();
  }

  private refreshClips() {
    clipStore
      .ids()
      .then((ids) => this.clipIds.set(ids))
      .catch(() => undefined);
  }

  protected async openClip(r: JumpRecord) {
    let clip = await clipStore.get(r.id).catch(() => undefined);
    if (!clip && r.hasClip) {
      this.opening.set(r.id);
      try {
        clip = await this.cloud.fetchClip(r.id);
        if (clip) this.clipIds.update((s) => new Set(s).add(r.id));
      } finally {
        this.opening.set(null);
      }
    }
    if (!clip) return;
    const ext = clip.mime.includes('mp4') ? 'mp4' : 'webm';
    const name = `jump-${r.date.slice(0, 10)}-${r.type.replace(/\W+/g, '-').toLowerCase()}-${r.heightCm}cm.${ext}`;
    this.viewing.set({ url: URL.createObjectURL(clip.video), fileName: name, clip });
  }

  protected closeClip() {
    const v = this.viewing();
    if (v) URL.revokeObjectURL(v.url);
    this.viewing.set(null);
  }

  protected async shareClip() {
    const v = this.viewing();
    if (!v) return;
    const file = new File([v.clip.video], v.fileName, { type: v.clip.mime });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'My jump' });
    } catch {
      /* user cancelled */
    }
  }

  private flushClipDeletes() {
    for (const id of this.pendingClipDeletes) clipStore.delete(id).catch(() => undefined);
    this.pendingClipDeletes.clear();
  }
  protected readonly undo = signal<JumpRecord | null>(null);
  private undoTimer?: ReturnType<typeof setTimeout>;
  protected readonly units = computed(() => this.store.settings().units);

  protected readonly typesInUse = computed<JumpType[]>(() => {
    const used = new Set(this.store.history().map((r) => r.type));
    return JUMP_TYPES.filter((t) => used.has(t));
  });

  protected readonly chosen = signal<JumpType | null>(null);
  protected readonly type = computed<JumpType>(() => {
    const c = this.chosen();
    return c && this.typesInUse().includes(c) ? c : (this.typesInUse()[0] ?? 'CMJ');
  });

  protected readonly filtered = computed(() => this.store.sorted().filter((r) => r.type === this.type()));
  protected readonly best = computed(() => maxBy(this.filtered(), (r) => r.heightCm));
  protected readonly recentAvg = computed(() => {
    const last = this.filtered().slice(0, 5);
    return last.length ? last.reduce((a, r) => a + r.heightCm, 0) / last.length : null;
  });
  protected readonly bestRsi = computed(() => maxBy(this.filtered(), (r) => r.rsi)?.rsi ?? null);
  protected readonly bestRsiMod = computed(() => maxBy(this.filtered(), (r) => r.rsiMod)?.rsiMod ?? null);

  /** Left vs right single-leg bests, when both exist and a single-leg tab is open. */
  protected readonly asymmetry = computed(() => {
    if (!this.type().startsWith('Single-leg')) return null;
    const all = this.store.history();
    const left = maxBy(all.filter((r) => r.type === 'Single-leg L'), (r) => r.heightCm)?.heightCm;
    const right = maxBy(all.filter((r) => r.type === 'Single-leg R'), (r) => r.heightCm)?.heightCm;
    if (!left || !right) return null;
    const pct = (Math.abs(left - right) / Math.max(left, right)) * 100;
    return { left, right, pct, weaker: left < right ? 'left' : 'right' };
  });

  private readonly allMetrics = computed<Metric[]>(() => {
    const u = this.units();
    return [
      { key: 'height', name: `Height (${u})`, get: (r) => toUnits(r.heightCm, u), higherIsBetter: true },
      { key: 'rsi', name: 'RSI', get: (r) => r.rsi, higherIsBetter: true },
      { key: 'contact', name: 'Contact time (ms)', get: (r) => r.contactMs, higherIsBetter: false },
      { key: 'rsiMod', name: 'RSI-mod', get: (r) => r.rsiMod, higherIsBetter: true },
      { key: 'ttt', name: 'Time to take-off (ms)', get: (r) => r.timeToTakeoffMs, higherIsBetter: false },
    ];
  });

  /** Metrics with at least two values for this jump type. */
  protected readonly metrics = computed(() =>
    this.allMetrics().filter((m) => this.filtered().filter((r) => m.get(r) !== undefined).length >= 2),
  );
  protected readonly chosenMetric = signal<MetricKey>('height');
  protected readonly metric = computed(
    () => this.metrics().find((m) => m.key === this.chosenMetric()) ?? this.allMetrics()[0],
  );

  protected readonly chartPoints = computed<ChartPoint[]>(() => {
    const m = this.metric();
    const u = this.units();
    return this.filtered()
      .filter((r) => m.get(r) !== undefined)
      .map((r) => {
        const value = m.get(r)!;
        const text =
          m.key === 'height'
            ? `${formatNumber(value, 1)} ${u}`
            : m.key === 'rsi' || m.key === 'rsiMod'
              ? `${m.name} ${formatNumber(value, 2)}`
              : `${formatNumber(value, 0)} ms`;
        return { id: r.id, date: r.date, value, text, note: r.note };
      });
  });

  protected methodLabel(r: JumpRecord) {
    return r.method === 'manual' ? 'marked by hand' : r.method === 'auto' ? 'auto-detected' : 'auto, adjusted';
  }

  protected remove(r: JumpRecord) {
    this.flushClipDeletes();
    this.store.remove(r.id);
    this.pendingClipDeletes.add(r.id);
    if (r.synced) this.cloud.deleteJump(r.id);
    this.undo.set(r);
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => {
      this.undo.set(null);
      this.flushClipDeletes();
    }, 6000);
  }

  protected restore() {
    const r = this.undo();
    if (r) {
      this.store.restore(r);
      this.pendingClipDeletes.delete(r.id);
      this.cloud.cancelDelete(r.id);
    }
    this.undo.set(null);
  }
}

function maxBy(rs: JumpRecord[], f: (r: JumpRecord) => number | undefined): JumpRecord | null {
  let best: JumpRecord | null = null;
  for (const r of rs) {
    const v = f(r);
    if (v === undefined) continue;
    if (!best || v > f(best)!) best = r;
  }
  return best;
}
