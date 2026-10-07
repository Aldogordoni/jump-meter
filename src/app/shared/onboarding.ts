import { AfterViewInit, Component, ElementRef, HostListener, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { StoreService } from '../core/store.service';
import { CloudService } from '../core/cloud.service';
import { fromUnits, toUnits } from '../core/jump-math';

/** First-run guide: what the app does, how to film, a few details, and (optionally) sign-in. */
@Component({
  selector: 'app-onboarding',
  imports: [FormsModule],
  template: `
    <div class="scrim">
      <div class="card" role="dialog" aria-modal="true" [attr.aria-labelledby]="'ob-h-' + step()">
        <div class="dots" aria-hidden="true">
          @for (s of [0, 1, 2, 3]; track s) {
            <span [class.on]="s === step()"></span>
          }
        </div>
        <p class="sr-only" aria-live="polite">Step {{ step() + 1 }} of 4</p>

        @switch (step()) {
          @case (0) {
            <h2 #heading tabindex="-1" id="ob-h-0">Measure your jump from a video</h2>
            <svg class="demo" viewBox="0 0 240 150" role="img" aria-label="A figure jumping, with the time in the air highlighted">
              <line x1="10" y1="132" x2="230" y2="132" class="floor" />
              <g class="jumper">
                <circle cx="120" cy="58" r="9" />
                <line x1="120" y1="67" x2="120" y2="98" />
                <line x1="120" y1="98" x2="113" y2="130" />
                <line x1="120" y1="98" x2="127" y2="130" />
                <line x1="120" y1="74" x2="108" y2="90" />
                <line x1="120" y1="74" x2="132" y2="90" />
              </g>
              <text x="120" y="20" text-anchor="middle" class="timer">in the air → height</text>
            </svg>
            <p>
              Film a jump, mark the frame you leave the ground and the frame you land, and Jump Meter works out your height
              from the time in the air. The on-device AI can find those frames for you.
            </p>
            <p class="small muted">Nothing leaves your phone unless you sign in to back up.</p>
          }
          @case (1) {
            <h2 #heading tabindex="-1" id="ob-h-1">Film it right</h2>
            <svg class="demo" viewBox="0 0 240 120" role="img" aria-label="Phone on the floor, side-on, about two metres from the jumper">
              <line x1="10" y1="104" x2="230" y2="104" class="floor" />
              <rect x="22" y="88" width="10" height="16" rx="2" class="phone" />
              <path d="M34 92 L190 40 M34 100 L190 104" class="cone" />
              <g class="still">
                <circle cx="180" cy="42" r="7" />
                <line x1="180" y1="49" x2="180" y2="74" />
                <line x1="180" y1="74" x2="175" y2="102" />
                <line x1="180" y1="74" x2="185" y2="102" />
              </g>
              <text x="105" y="118" text-anchor="middle" class="label">about 2 m</text>
            </svg>
            <ol class="tips">
              <li><strong>Slow motion, 240 fps</strong> if your phone has it. 120 is fine; 30 is too coarse.</li>
              <li><strong>Phone on the floor</strong>, side-on, with your whole body and feet in shot.</li>
              <li><strong>Land the way you took off</strong>: straight legs, toes pointed. The app checks this.</li>
            </ol>
            <p class="small muted">"Record now" has a live guide that tells you when the framing is right, and a hands-free mode.</p>
          }
          @case (2) {
            <h2 #heading tabindex="-1" id="ob-h-2">A few details (optional)</h2>
            <p class="small">Used to check the frame rate from your motion, estimate power, and compare you with norms.</p>
            <div class="seg" role="radiogroup" aria-label="Units">
              <button type="button" role="radio" [attr.aria-checked]="units() === 'cm'" [class.on]="units() === 'cm'" (click)="store.updateSettings({ units: 'cm' })">cm / kg</button>
              <button type="button" role="radio" [attr.aria-checked]="units() === 'in'" [class.on]="units() === 'in'" (click)="store.updateSettings({ units: 'in' })">in</button>
            </div>
            <div class="grid">
              <div class="field">
                <label for="ob-h">Your height ({{ units() }})</label>
                <input id="ob-h" type="number" inputmode="decimal" step="any" [ngModel]="statureInUnits()" (ngModelChange)="setStature($event)" />
              </div>
              <div class="field">
                <label for="ob-m">Body mass (kg)</label>
                <input id="ob-m" type="number" inputmode="decimal" step="any" [ngModel]="store.settings().massKg" (ngModelChange)="store.updateSettings({ massKg: $event ? +$event : null })" />
              </div>
              <div class="field">
                <label for="ob-s">Compare with</label>
                <select id="ob-s" [ngModel]="store.settings().sex" (ngModelChange)="store.updateSettings({ sex: $event || null })">
                  <option [ngValue]="null">Don't compare</option>
                  <option value="male">Men's norms</option>
                  <option value="female">Women's norms</option>
                </select>
              </div>
            </div>
          }
          @case (3) {
            <h2 #heading tabindex="-1" id="ob-h-3">Keep your jumps safe</h2>
            <p>
              Your jumps are saved on this phone. Sign in to back them up with their video clips and see them on any device.
              Accounts are invite-only.
            </p>
            @if (cloud.configured && !cloud.user()) {
              <button class="btn" type="button" (click)="finish('/account')">Sign in</button>
            }
          }
        }

        <div class="nav">
          @if (step() > 0) {
            <button class="btn ghost" type="button" (click)="go(-1)">Back</button>
          } @else {
            <button class="btn ghost" type="button" (click)="finish()">Skip</button>
          }
          @if (step() < 3) {
            <button class="btn primary" type="button" (click)="go(1)">Next</button>
          } @else {
            <button class="btn primary" type="button" (click)="finish()">Start measuring</button>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: rgba(10, 16, 28, 0.55);
      display: grid;
      place-items: center;
      padding: 16px;
    }
    .card {
      width: min(460px, 100%);
      max-height: calc(100dvh - 32px);
      overflow: auto;
      background: var(--paper);
      border-radius: var(--r-lg);
      padding: 18px 18px 14px;
      display: grid;
      gap: 12px;
    }
    h2 {
      margin: 0;
      outline: none;
    }
    p {
      margin: 0;
    }
    .dots {
      display: flex;
      gap: 6px;
      span {
        width: 22px;
        height: 4px;
        border-radius: 2px;
        background: var(--line);
        &.on {
          background: var(--red);
        }
      }
    }
    .demo {
      width: 100%;
      max-height: 170px;
      .floor {
        stroke: var(--ink);
        stroke-width: 2;
      }
      .jumper,
      .still {
        stroke: var(--blue);
        stroke-width: 4;
        stroke-linecap: round;
        fill: var(--blue);
      }
      .jumper {
        animation: hop 1.6s ease-in-out infinite;
      }
      .phone {
        fill: var(--ink);
      }
      .cone {
        stroke: var(--ink-soft);
        stroke-dasharray: 4 4;
        fill: none;
      }
      .timer,
      .label {
        font-size: 12px;
        fill: var(--ink-soft);
        font-family: var(--body);
      }
    }
    @keyframes hop {
      0%,
      30%,
      100% {
        transform: translateY(0);
      }
      55% {
        transform: translateY(-34px);
      }
      75% {
        transform: translateY(0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .demo .jumper {
        animation: none;
        transform: translateY(-20px);
      }
    }
    .tips {
      margin: 0;
      padding-left: 1.2em;
      display: grid;
      gap: 6px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      .field:last-child {
        grid-column: 1 / -1;
      }
    }
    .seg {
      display: inline-flex;
      justify-self: start;
      border: 1.5px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      button {
        min-height: 40px;
        padding: 0 16px;
        border: 0;
        background: var(--surface);
        color: var(--ink);
        font-weight: 600;
        cursor: pointer;
        &.on {
          background: var(--ink);
          color: var(--paper);
        }
      }
    }
    .nav {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-top: 4px;
    }
  `,
})
export class Onboarding implements AfterViewInit {
  protected readonly store = inject(StoreService);
  protected readonly cloud = inject(CloudService);
  private readonly router = inject(Router);
  readonly done = output<void>();
  protected readonly step = signal(0);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  protected readonly units = computed(() => this.store.settings().units);
  protected readonly statureInUnits = computed(() => {
    const cm = this.store.settings().statureCm;
    return cm === null ? null : Math.round(toUnits(cm, this.units()) * 10) / 10;
  });

  ngAfterViewInit() {
    this.focusHeading();
  }

  @HostListener('document:keydown.escape')
  protected onEscape() {
    this.finish();
  }

  protected go(d: number) {
    this.step.update((s) => Math.max(0, Math.min(3, s + d)));
    this.focusHeading();
  }

  private focusHeading() {
    setTimeout(() => this.heading()?.nativeElement.focus());
  }

  protected setStature(v: number | null) {
    const n = Number(v);
    const cm = n > 0 ? fromUnits(n, this.units()) : null;
    this.store.updateSettings({ statureCm: cm && cm > 100 && cm < 250 ? Math.round(cm) : null });
  }

  protected finish(route?: string) {
    this.store.updateSettings({ onboarded: true });
    this.done.emit();
    if (route) this.router.navigateByUrl(route);
  }
}
