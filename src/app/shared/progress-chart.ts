import { Component, computed, input, signal } from '@angular/core';
import { DecimalPipe, DatePipe } from '@angular/common';
import { JumpRecord } from '../core/jump-math';

/** Every jump as a dot, with a line through the best jump of each session (day). */
@Component({
  selector: 'app-progress-chart',
  imports: [DecimalPipe, DatePipe],
  template: `
    <div class="wrap">
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="summary()">
        @for (t of yTicks(); track t) {
          <line [attr.x1]="padL" [attr.x2]="W - padR" [attr.y1]="y(t)" [attr.y2]="y(t)" class="grid" />
          <text [attr.x]="padL - 6" [attr.y]="y(t) + 4" text-anchor="end" class="axis">{{ t }}</text>
        }
        <polyline [attr.points]="bestLine()" class="line" />
        @for (p of dots(); track p.r.id) {
          <circle
            [attr.cx]="p.x"
            [attr.cy]="p.y"
            [attr.r]="active()?.id === p.r.id ? 6 : 4"
            [class.best]="p.best"
            class="dot"
          />
          <circle
            [attr.cx]="p.x"
            [attr.cy]="p.y"
            r="14"
            class="hit"
            tabindex="0"
            (pointerenter)="active.set(p.r)"
            (focus)="active.set(p.r)"
            (click)="active.set(p.r)"
          >
            <title>{{ p.r.heightCm }} cm, {{ p.r.date | date: 'd MMM' }}</title>
          </circle>
        }
        <text [attr.x]="padL" [attr.y]="H - 4" class="axis">{{ first() | date: 'd MMM' }}</text>
        <text [attr.x]="W - padR" [attr.y]="H - 4" text-anchor="end" class="axis">{{ last() | date: 'd MMM' }}</text>
      </svg>
      <p class="tip" aria-live="polite">
        @if (active(); as a) {
          <strong class="num">{{ a.heightCm | number: '1.1-1' }} cm</strong>
          {{ a.type }} on {{ a.date | date: 'EEE d MMM, HH:mm' }}@if (a.note) {, {{ a.note }}}
        } @else {
          Tap a dot for details. The line follows your best jump each day.
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
  readonly records = input.required<JumpRecord[]>();
  protected readonly active = signal<JumpRecord | null>(null);

  protected readonly W = 340;
  protected readonly H = 190;
  protected readonly padL = 30;
  protected readonly padR = 10;
  private readonly padT = 10;
  private readonly padB = 22;

  private readonly sorted = computed(() => [...this.records()].sort((a, b) => a.date.localeCompare(b.date)));
  protected readonly first = computed(() => this.sorted()[0]?.date);
  protected readonly last = computed(() => this.sorted().at(-1)?.date);

  private readonly yDomain = computed(() => {
    const hs = this.sorted().map((r) => r.heightCm);
    const lo = Math.floor((Math.min(...hs) - 3) / 5) * 5;
    const hi = Math.ceil((Math.max(...hs) + 3) / 5) * 5;
    return { lo: Math.max(0, lo), hi: Math.max(hi, lo + 10) };
  });

  protected readonly yTicks = computed(() => {
    const { lo, hi } = this.yDomain();
    const step = hi - lo > 40 ? 10 : 5;
    const out: number[] = [];
    for (let t = lo; t <= hi; t += step) out.push(t);
    return out;
  });

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
    const map = new Map<string, JumpRecord>();
    for (const r of this.sorted()) {
      const day = r.date.slice(0, 10);
      const cur = map.get(day);
      if (!cur || r.heightCm > cur.heightCm) map.set(day, r);
    }
    return map;
  });

  protected readonly dots = computed(() => {
    const bestIds = new Set([...this.dailyBest().values()].map((r) => r.id));
    return this.sorted().map((r) => ({ r, x: this.x(r.date), y: this.y(r.heightCm), best: bestIds.has(r.id) }));
  });

  protected readonly bestLine = computed(() =>
    [...this.dailyBest().values()].map((r) => `${this.x(r.date).toFixed(1)},${this.y(r.heightCm).toFixed(1)}`).join(' '),
  );

  protected readonly summary = computed(() => {
    const s = this.sorted();
    if (!s.length) return 'No jumps yet';
    const best = Math.max(...s.map((r) => r.heightCm));
    return `${s.length} jumps from ${s[0].date.slice(0, 10)} to ${s.at(-1)!.date.slice(0, 10)}, best ${best} cm`;
  });
}
