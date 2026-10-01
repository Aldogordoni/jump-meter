import { Component, computed, input } from '@angular/core';

/**
 * Result display modelled on a Vertec jump tester: a pole with a vane every
 * centimetre. Vanes up to your jump height are swept aside.
 */
@Component({
  selector: 'app-vane-gauge',
  template: `
    <svg [attr.viewBox]="'0 0 320 ' + svgH()" role="img" [attr.aria-label]="label()">
      <line [attr.x1]="poleX" y1="6" [attr.x2]="poleX" [attr.y2]="svgH() - 4" class="pole" />
      @for (v of vanes(); track v.cm) {
        <g [attr.transform]="'translate(' + poleX + ' ' + v.y + ')'">
          <rect
            class="vane"
            [class.hit]="v.hit"
            [class.red]="v.cm % 10 === 0"
            [class.blue]="v.cm % 10 === 5"
            [style.animation-delay.ms]="v.delay"
            x="0"
            y="-1.4"
            [attr.width]="vaneLen"
            height="2.8"
            rx="1"
          />
        </g>
        @if (v.cm % 10 === 0) {
          <text class="tick" [attr.x]="poleX - 8" [attr.y]="v.y + 4" text-anchor="end">{{ v.cm }}</text>
        }
      }
      <g [attr.transform]="'translate(0 ' + topY() + ')'" class="reading">
        <line [attr.x1]="poleX" y1="0" x2="250" y2="0" class="reach" />
        <text x="314" y="-6" text-anchor="end" class="big">{{ heightCm().toFixed(1) }}</text>
        <text x="314" y="16" text-anchor="end" class="unit">cm</text>
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

  protected readonly poleX = 44;
  protected readonly vaneLen = 150;
  private readonly spacing = 5;

  protected readonly maxCm = computed(() => Math.max(50, Math.ceil((this.heightCm() + 8) / 10) * 10));
  protected readonly svgH = computed(() => this.maxCm() * this.spacing + 40);
  protected readonly topY = computed(() => this.yFor(Math.min(this.heightCm(), this.maxCm())));
  protected readonly label = computed(() => `Jump height ${this.heightCm().toFixed(1)} centimetres`);

  protected readonly vanes = computed(() => {
    const h = this.heightCm();
    const out: { cm: number; y: number; hit: boolean; delay: number }[] = [];
    for (let cm = 1; cm <= this.maxCm(); cm++) {
      const hit = cm <= h;
      out.push({ cm, y: this.yFor(cm), hit, delay: hit ? 120 + cm * 14 : 0 });
    }
    return out;
  });

  private yFor(cm: number) {
    return this.svgH() - 20 - cm * this.spacing;
  }
}
