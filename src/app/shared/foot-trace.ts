import { Component, computed, input, output } from '@angular/core';
import { FootSample } from '../core/flight-detect';

/** Foot height over the analysed frames, so you can sanity-check the auto-detection. */
@Component({
  selector: 'app-foot-trace',
  template: `
    <svg viewBox="0 0 320 120" role="img" aria-label="Foot height above the floor, frame by frame. Tap to jump to a frame." (click)="pick($event)">
      <line x1="0" [attr.y1]="floorY" x2="320" [attr.y2]="floorY" class="floor" />
      <polyline [attr.points]="points()" class="path" />
      @if (markers(); as m) {
        <line [attr.x1]="m.air" y1="8" [attr.x2]="m.air" [attr.y2]="floorY" class="mark" />
        <text [attr.x]="m.air + 3" y="16" class="lbl">take-off</text>
        <line [attr.x1]="m.ground" y1="8" [attr.x2]="m.ground" [attr.y2]="floorY" class="mark" />
        <text [attr.x]="m.ground - 3" y="16" class="lbl" text-anchor="end">landing</text>
      }
      @if (contactX() !== null) {
        <line [attr.x1]="contactX()" y1="8" [attr.x2]="contactX()" [attr.y2]="floorY" class="mark" />
        <text [attr.x]="contactX()! - 3" y="28" class="lbl" text-anchor="end">box landing</text>
      }
      @if (cursor() !== null) {
        <line [attr.x1]="cursor()" y1="0" [attr.x2]="cursor()" y2="112" class="cursor" />
      }
      <text x="0" y="118" class="axis">frame {{ range().min }}</text>
      <text x="320" y="118" class="axis" text-anchor="end">frame {{ range().max }}</text>
    </svg>
  `,
  styles: `
    svg {
      width: 100%;
      height: auto;
      display: block;
      cursor: crosshair;
      touch-action: manipulation;
    }
    .floor {
      stroke: var(--line);
      stroke-width: 1;
    }
    .path {
      fill: none;
      stroke: var(--blue);
      stroke-width: 2;
      stroke-linejoin: round;
    }
    .mark {
      stroke: var(--red);
      stroke-width: 1.5;
    }
    .cursor {
      stroke: var(--ink);
      stroke-width: 1;
      stroke-dasharray: 2 2;
    }
    .lbl,
    .axis {
      font-size: 10px;
      fill: var(--ink-soft);
      font-family: var(--body);
    }
  `,
})
export class FootTrace {
  readonly trace = input.required<FootSample[]>();
  readonly baseline = input.required<number>();
  readonly firstAir = input<number | null>(null);
  readonly firstGround = input<number | null>(null);
  readonly contact = input<number | null>(null);
  readonly current = input<number | null>(null);
  readonly seek = output<number>();

  protected readonly floorY = 104;

  protected readonly range = computed(() => {
    const t = this.trace();
    return { min: t[0]?.frame ?? 0, max: t[t.length - 1]?.frame ?? 1 };
  });

  private x(frame: number) {
    const { min, max } = this.range();
    return ((frame - min) / Math.max(1, max - min)) * 320;
  }

  protected readonly points = computed(() => {
    const t = this.trace();
    const base = this.baseline();
    const peak = Math.max(1e-6, ...t.map((s) => base - s.footY));
    return t.map((s) => `${this.x(s.frame).toFixed(1)},${(this.floorY - ((base - s.footY) / peak) * 90).toFixed(1)}`).join(' ');
  });

  protected readonly markers = computed(() => {
    const a = this.firstAir();
    const g = this.firstGround();
    return a === null || g === null ? null : { air: this.x(a), ground: this.x(g) };
  });

  protected readonly contactX = computed(() => {
    const c = this.contact();
    return c === null ? null : this.x(c);
  });

  protected readonly cursor = computed(() => {
    const c = this.current();
    const { min, max } = this.range();
    return c === null || c < min || c > max ? null : this.x(c);
  });

  protected pick(ev: MouseEvent) {
    const svg = ev.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const { min, max } = this.range();
    this.seek.emit(Math.round(min + ((ev.clientX - rect.left) / rect.width) * (max - min)));
  }
}
