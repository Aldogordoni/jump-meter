import { Component, computed, input } from '@angular/core';
import { toUnits, Units } from '../core/jump-math';
import { formatNumber } from '../core/height.pipe';

interface Scale {
  /** Distance between vanes, in display units. */
  step: number;
  red: number;
  blue: number;
  label: number;
  min: number;
  /** SVG units per vane. */
  spacing: number;
}

const SCALES: Record<Units, Scale> = {
  cm: { step: 1, red: 10, blue: 5, label: 10, min: 50, spacing: 5 },
  // Real Vertec vanes are half an inch apart.
  in: { step: 0.5, red: 6, blue: 3, label: 6, min: 24, spacing: 6 },
};

/**
 * Result display modelled on a Vertec jump tester: a pole of vanes.
 * Vanes up to your jump height are swept aside.
 */
@Component({
  selector: 'app-vane-gauge',
  template: `
    <svg [attr.viewBox]="'0 0 320 ' + svgH()" role="img" [attr.aria-label]="label()">
      <line [attr.x1]="poleX" y1="6" [attr.x2]="poleX" [attr.y2]="svgH() - 4" class="pole" />
      @for (v of vanes(); track v.key) {
        <g [attr.transform]="'translate(' + poleX + ' ' + v.y + ')'">
          <rect
            class="vane"
            [class.hit]="v.hit"
            [class.red]="v.red"
            [class.blue]="v.blue"
            [style.animation-delay.ms]="v.delay"
            x="0"
            y="-1.4"
            [attr.width]="vaneLen"
            height="2.8"
            rx="1"
          />
        </g>
        @if (v.label) {
          <text class="tick" [attr.x]="poleX - 8" [attr.y]="v.y + 4" text-anchor="end">{{ v.value }}</text>
        }
      }
      <g [attr.transform]="'translate(0 ' + topY() + ')'" class="reading">
        <line [attr.x1]="poleX" y1="0" x2="250" y2="0" class="reach" />
        <text x="314" y="-6" text-anchor="end" class="big">{{ display() }}</text>
        <text x="314" y="16" text-anchor="end" class="unit">{{ units() }}</text>
      </g>
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }
    svg {
      width: 100%;
      height: auto;
      max-height: 46vh;
      display: block;
      overflow: visible;
    }
    .pole {
      stroke: var(--ink);
      stroke-width: 3;
      stroke-linecap: round;
    }
    .vane {
      fill: var(--line);
      transform-origin: 0 0;
    }
    .vane.red {
      fill: var(--red);
    }
    .vane.blue {
      fill: var(--blue);
    }
    .vane.hit {
      animation: sweep 380ms cubic-bezier(0.3, 1.4, 0.5, 1) both;
    }
    @keyframes sweep {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0.14);
      }
    }
    .tick {
      font-family: var(--display);
      font-size: 13px;
      fill: var(--ink-soft);
    }
    .reach {
      stroke: var(--ink);
      stroke-width: 1.5;
      stroke-dasharray: 3 3;
    }
    .big {
      font-family: var(--display);
      font-weight: 700;
      font-size: 64px;
      fill: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .unit {
      font-family: var(--display);
      font-weight: 600;
      font-size: 20px;
      fill: var(--ink-soft);
    }
  `,
})
export class VaneGauge {
  readonly heightCm = input.required<number>();
  readonly units = input<Units>('cm');

  protected readonly poleX = 44;
  protected readonly vaneLen = 150;

  private readonly scale = computed(() => SCALES[this.units()]);
  /** Height in display units. */
  private readonly h = computed(() => toUnits(this.heightCm(), this.units()));
  protected readonly display = computed(() => formatNumber(this.h(), 1));

  private readonly max = computed(() => {
    const s = this.scale();
    return Math.max(s.min, Math.ceil((this.h() + s.label * 0.8) / s.label) * s.label);
  });
  private readonly count = computed(() => Math.round(this.max() / this.scale().step));
  protected readonly svgH = computed(() => this.count() * this.scale().spacing + 40);
  protected readonly topY = computed(() => this.yFor(Math.min(this.h(), this.max()) / this.scale().step));
  protected readonly label = computed(() => `Jump height ${this.display()} ${this.units() === 'in' ? 'inches' : 'centimetres'}`);

  protected readonly vanes = computed(() => {
    const s = this.scale();
    const h = this.h();
    const out: { key: string; value: number; y: number; hit: boolean; red: boolean; blue: boolean; label: boolean; delay: number }[] = [];
    for (let i = 1; i <= this.count(); i++) {
      const value = Math.round(i * s.step * 10) / 10;
      const hit = value <= h;
      const red = value % s.red === 0;
      out.push({
        key: `${this.units()}${i}`,
        value,
        y: this.yFor(i),
        hit,
        red,
        blue: !red && value % s.blue === 0,
        label: value % s.label === 0,
        delay: hit ? 120 + i * 14 : 0,
      });
    }
    return out;
  });

  private yFor(index: number) {
    return this.svgH() - 20 - index * this.scale().spacing;
  }
}
