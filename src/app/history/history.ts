import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { StoreService } from '../core/store.service';
import { JUMP_TYPES, JumpRecord, JumpType } from '../core/jump-math';
import { ProgressChart } from '../shared/progress-chart';

@Component({
  selector: 'app-history',
  imports: [DatePipe, DecimalPipe, RouterLink, ProgressChart],
  template: `
    <h1>History</h1>

    @if (!store.history().length) {
      <p>No jumps saved yet. Measure one and tap <strong>Save jump</strong>, and it shows up here with your progress over time.</p>
      <a class="btn primary" routerLink="/measure">Measure a jump</a>
    } @else {
      <div class="types" role="tablist" aria-label="Jump type">
        @for (t of typesInUse(); track t) {
          <button role="tab" type="button" [attr.aria-selected]="t === type()" [class.on]="t === type()" (click)="chosen.set(t)">
            {{ t }}
          </button>
        }
      </div>

      @if (best(); as b) {
        <div class="pb">
          <div>
            <span class="label">Best</span>
            <span class="num v">{{ b.heightCm | number: '1.1-1' }}<small>cm</small></span>
          </div>
          <div>
            <span class="label">Last 5 average</span>
            <span class="num v">{{ recentAvg() | number: '1.1-1' }}<small>cm</small></span>
          </div>
          <div>
            <span class="label">Jumps</span>
            <span class="num v">{{ filtered().length }}</span>
          </div>
        </div>
      }

      @if (filtered().length >= 2) {
        <app-progress-chart [records]="filtered()" />
      }

      <ul class="list">
        @for (r of filtered(); track r.id) {
          <li>
            <div class="h num">{{ r.heightCm | number: '1.1-1' }} <small>cm</small></div>
            <div class="meta">
              <span>{{ r.date | date: 'EEE d MMM yyyy, HH:mm' }}</span>
              <span class="muted">
                {{ r.flightMs | number: '1.0-0' }} ms flight, {{ r.captureFps }} fps, {{ methodLabel(r) }}
              </span>
              @if (r.note) {
                <span class="note">{{ r.note }}</span>
              }
            </div>
            <button class="btn ghost del" type="button" (click)="remove(r)" [attr.aria-label]="'Delete jump of ' + r.heightCm + ' cm'">
              Delete
            </button>
          </li>
        }
      </ul>
    }

    @if (undo(); as u) {
      <div class="toast" role="status">
        Deleted {{ u.heightCm | number: '1.1-1' }} cm jump.
        <button class="btn ghost" type="button" (click)="restore()">Undo</button>
      </div>
    }
  `,
  styles: `
    .types {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      margin-bottom: 16px;
      button {
        flex: none;
        min-height: 40px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1.5px solid var(--line);
        background: var(--surface);
        font-weight: 600;
        cursor: pointer;
      }
      button.on {
        background: var(--ink);
        color: var(--paper);
        border-color: var(--ink);
      }
    }
    .pb {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 16px;
      .label {
        display: block;
        font-size: 0.82rem;
        color: var(--ink-soft);
      }
      .v {
        font-size: 2rem;
        font-weight: 700;
        line-height: 1;
      }
      small {
        font-size: 0.9rem;
        margin-left: 2px;
        color: var(--ink-soft);
      }
      > div:first-child .v {
        color: var(--red);
      }
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
      .note {
        font-style: italic;
      }
      .del {
        color: var(--red);
        padding-inline: 0.6em;
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
export class History {
  protected readonly store = inject(StoreService);
  protected readonly undo = signal<JumpRecord | null>(null);
  private undoTimer?: ReturnType<typeof setTimeout>;

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
  protected readonly best = computed(() =>
    this.filtered().reduce<JumpRecord | null>((b, r) => (!b || r.heightCm > b.heightCm ? r : b), null),
  );
  protected readonly recentAvg = computed(() => {
    const last = this.filtered().slice(0, 5);
    return last.reduce((a, r) => a + r.heightCm, 0) / Math.max(1, last.length);
  });

  protected methodLabel(r: JumpRecord) {
    return r.method === 'manual' ? 'marked by hand' : r.method === 'auto' ? 'auto-detected' : 'auto, adjusted';
  }

  protected remove(r: JumpRecord) {
    this.store.remove(r.id);
    this.undo.set(r);
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.undo.set(null), 6000);
  }

  protected restore() {
    const r = this.undo();
    if (r) this.store.restore(r);
    this.undo.set(null);
  }
}
