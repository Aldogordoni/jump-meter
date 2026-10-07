import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { StoreService } from '../core/store.service';
import { JUMP_TYPES, JumpRecord, JumpType, toUnits } from '../core/jump-math';
import { HeightPipe, formatNumber } from '../core/height.pipe';
import { ChartPoint, ProgressChart } from '../shared/progress-chart';
import { clipStore, StoredClip } from '../core/clip-store';
import { CloudService } from '../core/cloud.service';
import { JumpEditor } from '../shared/jump-editor';
import { ClipViewer, ViewClip } from '../shared/clip-viewer';
import { Comments } from '../shared/comments';
import { SquadService } from '../core/squad.service';
import { cardDataFor, drawShareCard, shareImage } from '../core/share-card';
import { Metric as InsightMetric, Session, agreement, groupSessions, isPersonalRecord, readiness, tagStats } from '../core/insights';

type MetricKey = 'height' | 'rsi' | 'contact' | 'rsiMod' | 'ttt' | 'distance' | 'reach';

interface Metric {
  key: MetricKey;
  name: string;
  get: (r: JumpRecord) => number | undefined;
  higherIsBetter: boolean;
}

@Component({
  selector: 'app-history',
  imports: [DatePipe, DecimalPipe, RouterLink, ProgressChart, HeightPipe, JumpEditor, ClipViewer, Comments],
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

      @if (tagsInUse().length) {
        <div class="chips small-chips tag-filter" role="group" aria-label="Filter by tag">
          <button type="button" [class.on]="!tagFilter()" (click)="tagFilter.set(null)">All</button>
          @for (t of tagsInUse(); track t) {
            <button type="button" [class.on]="tagFilter() === t" [attr.aria-pressed]="tagFilter() === t" (click)="tagFilter.set(tagFilter() === t ? null : t)">{{ t }}</button>
          }
        </div>
      }

      @if (chartPoints().length >= 2) {
        @if (canGroup()) {
          <div class="seg" role="radiogroup" aria-label="Chart points">
            <button type="button" role="radio" [attr.aria-checked]="bySession()" [class.on]="bySession()" (click)="bySession.set(true)">Sessions</button>
            <button type="button" role="radio" [attr.aria-checked]="!bySession()" [class.on]="!bySession()" (click)="bySession.set(false)">Every jump</button>
          </div>
        }
        <app-progress-chart
          [points]="chartPoints()"
          [higherIsBetter]="metric().higherIsBetter"
          [metricName]="metric().name"
          [band]="normalBand()"
          [showTrend]="chartPoints().length >= 4"
        />
      }

      @if (tagInsights().length) {
        <section class="panel">
          <h2>What makes a difference</h2>
          <p class="small muted">Average {{ type() }} height with each tag compared with without it.</p>
          <ul class="tag-insights">
            @for (t of tagInsights(); track t.tag) {
              <li>
                <span class="t">{{ t.tag }}</span>
                <span class="num" [class.up]="t.diffPct > 0" [class.down]="t.diffPct < 0">{{ t.diffPct > 0 ? '+' : '' }}{{ t.diffPct | number: '1.1-1' }}%</span>
                <span class="small muted">{{ t.withMean | height }} vs {{ t.withoutMean | height }}, {{ t.nWith }} vs {{ t.nWithout }} jumps</span>
              </li>
            }
          </ul>
        </section>
      }

      @if (validation(); as v) {
        <section class="panel">
          <h2>Agreement with your other device</h2>
          <p class="small">
            On {{ v.n }} jumps measured both ways, Jump Meter reads
            <strong>{{ v.bias >= 0 ? 'higher' : 'lower' }} by {{ abs(v.bias) | height: 'full' : 1 }}</strong> on average.
            95% of differences fall between {{ v.loaLow | height: 'full' : 1 }} and {{ v.loaHigh | height: 'full' : 1 }}
            (mean difference {{ v.mape | number: '1.0-1' }}%@if (v.r !== null) {, correlation {{ v.r | number: '1.2-2' }}}).
          </p>
          <p class="small muted">Under 2 cm average difference and a correlation above 0.95 is excellent agreement.</p>
        </section>
      }

      @for (sess of sessionsShown(); track sess.id) {
        <section class="session" [attr.aria-label]="'Session ' + (sess.start | date: 'EEE d MMM')">
          <header class="sess-head">
            <span class="when">{{ sess.start | date: 'EEE d MMM yyyy, HH:mm' }}</span>
            @if (sess.jumps.length > 1) {
              <span class="small muted">
                {{ sess.jumps.length }} jumps, best {{ sess.best | height }}, average {{ sess.mean | height }}@if (sess.cv !== null) {, variation {{ sess.cv | number: '1.1-1' }}%}
              </span>
            }
          </header>
          <ul class="list">
            @for (r of sess.jumps; track r.id) {
              <li>
                <div class="h num">
                  {{ r.heightCm | height: 'value' }} <small>{{ units() }}</small>
                  @if (prIds().has(r.id)) {
                    <span class="badge pr" title="Personal record when it was set">PR</span>
                  }
                </div>
                <div class="meta">
                  <span>
                    {{ r.date | date: 'HH:mm' }}
                    <button class="link" type="button" (click)="editing.set(editing() === r.id ? null : r.id)">Edit</button>
                  </span>
                  @if (r.rsi !== undefined) {
                    <span class="stat">RSI {{ r.rsi | number: '1.2-2' }}, contact {{ r.contactMs | number: '1.0-0' }} ms@if (r.boxCm) {, {{ r.boxCm | height: 'full' : 0 }} box}</span>
                  }
                  @if (r.rsiMod !== undefined) {
                    <span class="stat">RSI-mod {{ r.rsiMod | number: '1.2-2' }}, {{ r.timeToTakeoffMs | number: '1.0-0' }} ms to take-off</span>
                  }
                  @if (r.hops?.length) {
                    <span class="stat">{{ r.hops!.length }} hops, best RSI {{ bestHopRsi(r) | number: '1.2-2' }}</span>
                  }
                  @if (r.distanceCm !== undefined) {
                    <span class="stat">Distance {{ r.distanceCm | height: 'full' : 0 }}</span>
                  }
                  @if (r.reachCm !== undefined) {
                    <span class="stat">Reach {{ r.reachCm | height }}</span>
                  }
                  @if (r.kinematics; as k) {
                    @if (k.depthCm !== null) {
                      <span class="muted">Dip {{ k.depthCm | height: 'full' : 0 }}@if (k.concentricMs !== null) {, push {{ k.concentricMs | number: '1.0-0' }} ms}</span>
                    }
                  }
                  @if (r.posture?.flagged) {
                    <span class="warn-line">Landing looked bent: may read about {{ r.posture!.inflationCm | height: 'full' : 1 }} high</span>
                  }
                  @if (r.confidence && r.confidence.level !== 'high') {
                    <span class="muted">Confidence: {{ r.confidence.level }}</span>
                  }
                  <span class="muted">
                    {{ r.flightMs | number: '1.0-0' }} ms flight, {{ r.captureFps }} fps, {{ methodLabel(r) }}
                  </span>
                  @if (r.reference) {
                    <span class="muted">{{ r.reference.device }}: {{ r.reference.heightCm | height }}</span>
                  }
                  @if (r.tags?.length) {
                    <span class="tags">
                      @for (t of r.tags!; track t) {
                        <span class="tag">{{ t }}</span>
                      }
                    </span>
                  }
                  @if (r.note) {
                    <span class="note">{{ r.note }}</span>
                  }
                  <span class="row-actions">
                    @if (clipIds().has(r.id) || r.hasClip) {
                      <button class="thumb" type="button" (click)="openClip(r)" [disabled]="opening() === r.id">
                        @if (posters()[r.id]; as src) {
                          <img [src]="src" alt="" />
                        }
                        <span>{{ opening() === r.id ? 'Downloading clip…' : compareFrom() && compareFrom()!.id !== r.id ? 'Compare with this' : 'Watch clip' }}</span>
                      </button>
                      @if (!compareFrom()) {
                        <button class="link" type="button" (click)="compareFrom.set(r)">Compare</button>
                      }
                    }
                    <button class="link" type="button" (click)="shareCard(r)" [disabled]="sharing() === r.id">
                      {{ sharing() === r.id ? 'Making card…' : 'Share card' }}
                    </button>
                    @if (cloud.signedIn() && r.synced) {
                      <button class="link" type="button" (click)="thread.set(thread() === r.id ? null : r.id)" [attr.aria-expanded]="thread() === r.id">
                        Comments@if (commentCounts()[r.id]) { ({{ commentCounts()[r.id] }})}
                      </button>
                    }
                  </span>
                  @if (thread() === r.id) {
                    <app-comments [jumpId]="r.id" [canModerate]="true" hint="Coaches you share with can comment here too." (count)="setCount(r.id, $event)" />
                  }
                  @if (editing() === r.id) {
                    <app-jump-editor [jump]="r" (closed)="editing.set(null)" />
                  }
                </div>
                <button class="btn ghost del" type="button" (click)="remove(r)" [attr.aria-label]="'Delete jump of ' + (r.heightCm | height)">
                  Delete
                </button>
              </li>
            }
          </ul>
        </section>
      }
      @if (sessionsAll().length > sessionsShown().length) {
        <button class="btn" type="button" (click)="showCount.set(showCount() + 20)">Show older sessions</button>
      }
    }

    @if (viewing(); as v) {
      <app-clip-viewer [clips]="v" (closed)="closeClip()" (trimmed)="onTrimmed($event)" />
    }
    @if (compareFrom(); as cf) {
      <div class="compare-bar" role="status">
        Pick another jump to compare with your {{ cf.heightCm | height }} jump.
        <button class="btn ghost" type="button" (click)="compareFrom.set(null)">Cancel</button>
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
    .link {
      border: 0;
      background: none;
      padding: 0 0 0 6px;
      color: var(--blue);
      font: inherit;
      font-size: 0.82rem;
      text-decoration: underline;
      cursor: pointer;
    }
    .date-edit {
      display: flex;
      gap: 6px;
      align-items: center;
      input {
        min-height: 40px;
        padding: 0 8px;
        border: 1.5px solid var(--line);
        border-radius: var(--r-sm);
        background: var(--surface);
        max-width: 100%;
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
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 14px;
      margin-top: 2px;
    }
    .compare-bar {
      position: fixed;
      left: 12px;
      right: 12px;
      bottom: calc(70px + env(safe-area-inset-bottom));
      z-index: 15;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border-radius: var(--r-lg);
      background: var(--ink);
      color: var(--paper);
      font-weight: 600;
      .btn {
        color: var(--paper);
        border-color: var(--paper);
      }
    }
    .seg {
      display: inline-flex;
      border: 1.5px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 4px;
      button {
        min-height: 32px;
        padding: 0 14px;
        border: 0;
        background: var(--surface);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
        &.on {
          background: var(--ink);
          color: var(--paper);
        }
      }
    }
    .panel {
      margin: 16px 0;
      padding: 12px;
      background: var(--surface);
      border-radius: var(--r-lg);
      h2 {
        font-size: 1.15rem;
        margin: 0 0 4px;
      }
      p {
        margin: 0 0 6px;
      }
    }
    .tag-insights {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0 8px;
        padding: 6px 0;
        border-top: 1px solid var(--line);
      }
      .t {
        font-weight: 600;
      }
      .num {
        font-weight: 700;
        &.up {
          color: var(--ok);
        }
        &.down {
          color: var(--red);
        }
      }
      .small {
        grid-column: 1 / -1;
      }
    }
    .session {
      margin-top: 18px;
    }
    .sess-head {
      display: grid;
      padding-bottom: 4px;
      .when {
        font-family: var(--display);
        font-weight: 700;
        font-size: 1.1rem;
      }
    }
    .badge {
      display: inline-block;
      margin-left: 4px;
      padding: 0 6px;
      border-radius: 999px;
      font-family: var(--body);
      font-size: 0.7rem;
      font-weight: 700;
      vertical-align: middle;
      &.pr {
        background: var(--red);
        color: var(--on-accent);
      }
    }
    .warn-line {
      color: var(--red);
      font-weight: 600;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 2px;
    }
    .tag {
      padding: 0 8px;
      border-radius: 999px;
      background: var(--paper);
      border: 1px solid var(--line);
      font-size: 0.78rem;
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
  protected readonly cloud = inject(CloudService);
  private readonly squadSvc = inject(SquadService);
  protected readonly thread = signal<string | null>(null);
  protected readonly commentCounts = signal<Record<string, number>>({});
  private readonly countsAsked = new Set<string>();
  protected readonly opening = signal<string | null>(null);
  private readonly posterRequested = new Set<string>();
  protected readonly clipIds = signal<Set<string>>(new Set());
  protected readonly posters = signal<Record<string, string>>({});
  protected readonly viewing = signal<ViewClip[] | null>(null);
  protected readonly compareFrom = signal<JumpRecord | null>(null);
  protected readonly sharing = signal<string | null>(null);
  private readonly pendingClipDeletes = new Set<string>();

  constructor() {
    this.refreshClips();
    // Comment counts for the jumps on screen (coach feedback).
    effect(() => {
      if (!this.cloud.signedIn()) return;
      const ids = this.sessionsShown()
        .flatMap((s) => s.jumps)
        .filter((r) => r.synced && !this.countsAsked.has(r.id))
        .map((r) => r.id);
      if (!ids.length) return;
      ids.forEach((id) => this.countsAsked.add(id));
      this.squadSvc
        .commentCounts(ids)
        .then((c) => this.commentCounts.update((x) => ({ ...x, ...c })))
        .catch(() => undefined);
    });
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

  protected setCount(id: string, n: number) {
    this.commentCounts.update((c) => ({ ...c, [id]: n }));
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

  private async loadClip(r: JumpRecord): Promise<StoredClip | undefined> {
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
    return clip;
  }

  private toView(r: JumpRecord, clip: StoredClip): ViewClip {
    const ext = clip.mime.includes('mp4') ? 'mp4' : 'webm';
    const u = this.units();
    return {
      id: r.id,
      url: URL.createObjectURL(clip.video),
      label: `${formatNumber(toUnits(r.heightCm, u), 1)} ${u} ${r.type}, ${new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
      fileName: `jump-${r.date.slice(0, 10)}-${r.type.replace(/\W+/g, '-').toLowerCase()}-${r.heightCm}cm.${ext}`,
      video: clip.video,
      mime: clip.mime,
    };
  }

  protected async openClip(r: JumpRecord) {
    const first = this.compareFrom();
    const clip = await this.loadClip(r);
    if (!clip) return;
    if (first && first.id !== r.id) {
      const other = await this.loadClip(first);
      this.compareFrom.set(null);
      if (other) {
        // Older jump on the left.
        const pair = [this.toView(first, other), this.toView(r, clip)];
        this.viewing.set(first.date <= r.date ? pair : pair.reverse());
        return;
      }
    }
    this.viewing.set([this.toView(r, clip)]);
  }

  protected closeClip() {
    for (const v of this.viewing() ?? []) URL.revokeObjectURL(v.url);
    this.viewing.set(null);
  }

  protected onTrimmed(id: string) {
    this.closeClip();
    const old = this.posters()[id];
    if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
    this.posters.update(({ [id]: _, ...rest }) => rest);
    this.posterRequested.delete(id);
    this.refreshClips();
  }

  protected async shareCard(r: JumpRecord) {
    this.sharing.set(r.id);
    try {
      const clip = await clipStore.get(r.id).catch(() => undefined);
      const all = this.ofType();
      const metric = r.type === 'Broad jump' && r.distanceCm !== undefined ? 'distanceCm' : 'heightCm';
      const blob = await drawShareCard(
        cardDataFor(r, this.units(), {
          pr: isPersonalRecord(all, r, metric),
          name: this.cloud.user() ? this.cloud.shownName() : null,
          image: clip?.poster ?? null,
          captioned: true,
        }),
      );
      await shareImage(blob, `jump-${r.date.slice(0, 10)}.png`, 'My jump');
    } finally {
      this.sharing.set(null);
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

  protected readonly tagFilter = signal<string | null>(null);
  /** All jumps of this type (ignores the tag filter). */
  private readonly ofType = computed(() => this.store.sorted().filter((r) => r.type === this.type()));
  protected readonly tagsInUse = computed(() => [...new Set(this.ofType().flatMap((r) => r.tags ?? []))].sort());
  protected readonly filtered = computed(() => {
    const t = this.tagFilter();
    return t ? this.ofType().filter((r) => r.tags?.includes(t)) : this.ofType();
  });

  protected readonly editing = signal<string | null>(null);
  protected readonly bySession = signal(true);
  protected readonly showCount = signal(20);
  private readonly scoreMode = computed(() => this.store.settings().sessionScore);

  /** Newest session first, for the list. Scored on height. */
  protected readonly sessionsAll = computed<Session[]>(() =>
    [...groupSessions(this.filtered(), this.type(), 'heightCm', this.scoreMode())].reverse().map((s) => ({
      ...s,
      jumps: [...s.jumps].reverse(),
    })),
  );
  protected readonly sessionsShown = computed(() => this.sessionsAll().slice(0, this.showCount()));

  /** Jumps that were a personal record when they were set. */
  protected readonly prIds = computed(() => {
    const all = this.ofType();
    const metric = this.type() === 'Broad jump' ? 'distanceCm' : 'heightCm';
    return new Set(all.filter((r) => isPersonalRecord(all, r, metric)).map((r) => r.id));
  });

  protected readonly tagInsights = computed(() => tagStats(this.ofType()).slice(0, 6));
  protected readonly validation = computed(() => agreement(this.ofType()));
  protected abs = Math.abs;

  protected bestHopRsi(r: JumpRecord) {
    return Math.max(...(r.hops ?? []).map((h) => h.rsi ?? 0));
  }

  /** Session view applies to metrics that have a "best". */
  private readonly insightMetric = computed<InsightMetric | null>(() => {
    const k = this.metric().key;
    const map: Partial<Record<MetricKey, InsightMetric>> = {
      height: 'heightCm', rsi: 'rsi', rsiMod: 'rsiMod', distance: 'distanceCm', reach: 'reachCm',
    };
    return map[k] ?? null;
  });
  protected readonly canGroup = computed(() => this.insightMetric() !== null && this.sessionsAll().length < this.filtered().length);

  /** Baseline ± smallest worthwhile change, in chart units. */
  protected readonly normalBand = computed(() => {
    const m = this.insightMetric();
    if (!m || !this.bySession()) return null;
    const r = readiness(groupSessions(this.filtered(), this.type(), m, this.scoreMode()));
    if (!r) return null;
    const conv = (v: number) => (m === 'heightCm' || m === 'distanceCm' || m === 'reachCm' ? toUnits(v, this.units()) : v);
    return { lo: conv(r.baseline - r.swc), hi: conv(r.baseline + r.swc) };
  });
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
      { key: 'distance', name: `Distance (${u})`, get: (r) => (r.distanceCm === undefined ? undefined : toUnits(r.distanceCm, u)), higherIsBetter: true },
      { key: 'height', name: `Height (${u})`, get: (r) => toUnits(r.heightCm, u), higherIsBetter: true },
      { key: 'reach', name: `Reach (${u})`, get: (r) => (r.reachCm === undefined ? undefined : toUnits(r.reachCm, u)), higherIsBetter: true },
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
  protected readonly chosenMetric = signal<MetricKey | null>(null);
  protected readonly metric = computed(() => {
    const ms = this.metrics();
    // Broad jumps are about distance; everything else defaults to height.
    const fallback = this.type() === 'Broad jump' ? 'distance' : 'height';
    return (
      ms.find((m) => m.key === this.chosenMetric()) ??
      ms.find((m) => m.key === fallback) ??
      this.allMetrics().find((m) => m.key === 'height')!
    );
  });

  protected readonly chartPoints = computed<ChartPoint[]>(() => {
    const m = this.metric();
    const u = this.units();
    const im = this.insightMetric();
    if (im && this.bySession() && this.canGroup()) {
      return groupSessions(this.filtered(), this.type(), im, this.scoreMode()).map((s) => {
        const value = m.get({ ...s.jumps[0], heightCm: s.score, rsi: s.score, rsiMod: s.score, distanceCm: s.score, reachCm: s.score })!;
        const text =
          m.key === 'height' || m.key === 'distance' || m.key === 'reach' ? `${formatNumber(value, 1)} ${u}` : `${m.name} ${formatNumber(value, 2)}`;
        return { id: s.id, date: s.start, value, text: `Session: ${text} (${s.jumps.length} jumps)` };
      });
    }
    return this.filtered()
      .filter((r) => m.get(r) !== undefined)
      .map((r) => {
        const value = m.get(r)!;
        const text =
          m.key === 'height' || m.key === 'distance' || m.key === 'reach'
            ? `${formatNumber(value, 1)} ${u}`
            : m.key === 'rsi' || m.key === 'rsiMod'
              ? `${m.name} ${formatNumber(value, 2)}`
              : `${formatNumber(value, 0)} ms`;
        return { id: r.id, date: r.date, value, text, note: r.note };
      });
  });

  protected readonly editingDate = signal<string | null>(null);

  protected toLocal(iso: string) {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  protected saveDate(r: JumpRecord, local: string) {
    const d = new Date(local);
    if (isNaN(d.getTime())) return;
    this.store.setDate(r.id, d.toISOString());
    this.editingDate.set(null);
  }

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
