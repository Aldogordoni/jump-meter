import { Component, computed, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

export interface ChartPoint {
  id: string;
  date: string;
  value: number;
  /** Text shown for this point, already formatted with units. */
  text: string;
  note?: string;
}

/**
 * Every jump as a dot, with a line through the best value of each day.
 * `higherIsBetter` decides which value counts as "best" (contact time: lower).
 */
@Component({
  selector: 'app-progress-chart',
  imports: [DatePipe],
  template: `
    <div class="wrap">
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="summary()">
        @for (t of yTicks(); track t) {
          <line [attr.x1]="padL" [attr.x2]="W - padR" [attr.y1]="y(t)" [attr.y2]="y(t)" class="grid" />
          <text [attr.x]="padL - 6" [attr.y]="y(t) + 4" text-anchor="end" class="axis">{{ fmtTick(t) }}</text>
        }
        @if (bandRect(); as b) {
          <rect [attr.x]="padL" [attr.width]="W - padL - padR" [attr.y]="b.y" [attr.height]="b.h" class="band" />
          <text [attr.x]="W - padR - 4" [attr.y]="b.y - 3" text-anchor="end" class="axis">your normal range</text>
        }
        <polyline [attr.points]="bestLine()" class="line" />
        @if (trendLine()) {
          <polyline [attr.points]="trendLine()" class="trend" />
        }
        @for (p of dots(); track p.d.id) {
          <circle [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="active()?.id === p.d.id ? 6 : 4" [class.best]="p.best" class="dot" />
          <circle
            [attr.cx]="p.x"
            [attr.cy]="p.y"
            r="14"
            class="hit"
            tabindex="0"
            (pointerenter)="active.set(p.d)"
            (focus)="active.set(p.d)"
            (click)="active.set(p.d)"
          >
            <title>{{ p.d.text }}, {{ p.d.date | date: 'd MMM' }}</title>
          </circle>
        }
        <text [attr.x]="padL" [attr.y]="H - 4" class="axis">{{ first() | date: 'd MMM' }}</text>
        <text [attr.x]="W - padR" [attr.y]="H - 4" text-anchor="end" class="axis">{{ last() | date: 'd MMM' }}</text>
      </svg>
      <p class="tip" aria-live="polite">
        @if (active(); as a) {
          <strong class="num">{{ a.text }}</strong>
          on {{ a.date | date: 'EEE d MMM, HH:mm' }}@if (a.note) {, {{ a.note }}}
        } @else {
          Tap a dot for details.@if (showTrend()) { The dashed line is your rolling average. }
        }
      </p>
    </div>
  `,
  styles: `
    svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .grid {
      stroke: var(--line);
      stroke-width: 1;
    }
    .axis {
      font-size: 11px;
      fill: var(--ink-soft);
      font-family: var(--body);
    }
    .line {
      fill: none;
      stroke: var(--blue);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .band {
      fill: var(--blue);
      opacity: 0.1;
    }
    .trend {
      fill: none;
      stroke: var(--ink-soft);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
    }
    .dot {
      fill: var(--surface);
      stroke: var(--blue);
      stroke-width: 2;
    }
    .dot.best {
      fill: var(--blue);
    }
    .hit {
      fill: transparent;
      cursor: pointer;
      outline: none;
    }
    .hit:focus-visible {
      stroke: var(--focus);
      stroke-width: 2;
    }
    .tip {
      min-height: 3em;
      font-size: 0.9rem;
      margin: 6px 0 0;
    }
  `,
})
export class ProgressChart {
  readonly points = input.required<ChartPoint[]>();
  readonly higherIsBetter = input(true);
  /** Decimal places on the axis. */
  readonly digits = input(0);
  readonly metricName = input('Value');
  /** Shaded reference band (e.g. baseline ± smallest worthwhile change). */
  readonly band = input<{ lo: number; hi: number } | null>(null);
  /** Dashed rolling average (last 5 points). */
  readonly showTrend = input(false);
  protected readonly active = signal<ChartPoint | null>(null);

  protected readonly W = 340;
  protected readonly H = 190;
  protected readonly padL = 34;
  protected readonly padR = 10;
  private readonly padT = 10;
  private readonly padB = 22;

  private readonly sorted = computed(() => [...this.points()].sort((a, b) => a.date.localeCompare(b.date)));
  protected readonly first = computed(() => this.sorted()[0]?.date);
  protected readonly last = computed(() => this.sorted().at(-1)?.date);

  protected readonly bandRect = computed(() => {
    const b = this.band();
    if (!b) return null;
    const top = this.y(b.hi);
    return { y: top, h: Math.max(2, this.y(b.lo) - top) };
  });

  protected readonly trendLine = computed(() => {
    if (!this.showTrend()) return '';
    const pts = this.sorted();
    if (pts.length < 4) return '';
    return pts
      .map((p, i) => {
        const win = pts.slice(Math.max(0, i - 4), i + 1);
        const avg = win.reduce((a, q) => a + q.value, 0) / win.length;
        return `${this.x(p.date).toFixed(1)},${this.y(avg).toFixed(1)}`;
      })
      .join(' ');
  });

  private readonly yDomain = computed(() => {
    const band = this.band();
    const vs = [...this.sorted().map((p) => p.value), ...(band ? [band.lo, band.hi] : [])];
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const span = Math.max(hi - lo, Math.abs(hi) * 0.1, 1e-6);
    const step = niceStep(span / 3);
    const a = Math.max(0, Math.floor((lo - span * 0.15) / step) * step);
    const b = Math.ceil((hi + span * 0.15) / step) * step;
    return { lo: a, hi: b > a ? b : a + step, step };
  });

  protected readonly yTicks = computed(() => {
    const { lo, hi, step } = this.yDomain();
    const out: number[] = [];
    for (let t = lo; t <= hi + step / 2; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  });

  protected fmtTick(t: number) {
    const step = this.yDomain().step;
    const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return t.toFixed(Math.max(d, 0));
  }

  protected y(v: number) {
    const { lo, hi } = this.yDomain();
    return this.padT + (1 - (v - lo) / (hi - lo)) * (this.H - this.padT - this.padB);
  }

  private x(date: string) {
    const t0 = Date.parse(this.first()!);
    const t1 = Date.parse(this.last()!);
    const f = t1 > t0 ? (Date.parse(date) - t0) / (t1 - t0) : 0.5;
    return this.padL + 8 + f * (this.W - this.padL - this.padR - 16);
  }

  private readonly dailyBest = computed(() => {
    const better = (a: number, b: number) => (this.higherIsBetter() ? a > b : a < b);
    const map = new Map<string, ChartPoint>();
    for (const p of this.sorted()) {
      const day = p.date.slice(0, 10);
      const cur = map.get(day);
      if (!cur || better(p.value, cur.value)) map.set(day, p);
    }
    return map;
  });

  protected readonly dots = computed(() => {
    const bestIds = new Set([...this.dailyBest().values()].map((p) => p.id));
    return this.sorted().map((d) => ({ d, x: this.x(d.date), y: this.y(d.value), best: bestIds.has(d.id) }));
  });

  protected readonly bestLine = computed(() =>
    [...this.dailyBest().values()].map((p) => `${this.x(p.date).toFixed(1)},${this.y(p.value).toFixed(1)}`).join(' '),
  );

  protected readonly summary = computed(() => {
    const s = this.sorted();
    if (!s.length) return 'No data yet';
    return `${this.metricName()} for ${s.length} jumps from ${s[0].date.slice(0, 10)} to ${s.at(-1)!.date.slice(0, 10)}`;
  });
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
