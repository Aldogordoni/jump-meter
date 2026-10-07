import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JumpRecord, fromUnits, toUnits } from '../core/jump-math';
import { StoreService } from '../core/store.service';
import { TagPicker } from './tag-picker';

/** Edit a saved jump: date, tags, note, and a reference value from another device. */
@Component({
  selector: 'app-jump-editor',
  imports: [FormsModule, TagPicker],
  template: `
    <div class="editor">
      <div class="field">
        <label [for]="'d-' + jump().id">Date</label>
        <input [id]="'d-' + jump().id" type="datetime-local" [ngModel]="date()" (ngModelChange)="date.set($event)" />
      </div>
      <div class="field">
        <span class="lbl">Tags</span>
        <app-tag-picker [selected]="tags()" (changed)="tags.set($event)" />
      </div>
      <div class="field">
        <label [for]="'n-' + jump().id">Note</label>
        <input [id]="'n-' + jump().id" type="text" maxlength="500" [ngModel]="note()" (ngModelChange)="note.set($event)" />
      </div>
      <fieldset>
        <legend>Compare with another device</legend>
        <p class="hint">
          Measured the same jump with a contact mat, force plate or another app? Enter its result to see how closely
          Jump Meter agrees.
        </p>
        <div class="row2">
          <div class="field">
            <label [for]="'r-' + jump().id">Its height ({{ units() }})</label>
            <input [id]="'r-' + jump().id" type="number" inputmode="decimal" step="any" min="0" [ngModel]="refValue()" (ngModelChange)="refValue.set($event)" />
          </div>
          <div class="field">
            <label [for]="'rd-' + jump().id">Device</label>
            <input [id]="'rd-' + jump().id" type="text" maxlength="40" placeholder="e.g. Chronojump mat" [ngModel]="refDevice()" (ngModelChange)="refDevice.set($event)" />
          </div>
        </div>
      </fieldset>
      <div class="actions">
        <button class="btn primary" type="button" (click)="save()">Save changes</button>
        <button class="btn ghost" type="button" (click)="closed.emit()">Cancel</button>
      </div>
    </div>
  `,
  styles: `
    .editor {
      display: grid;
      gap: 12px;
      padding: 12px;
      margin-top: 8px;
      background: var(--surface);
      border-radius: var(--r-lg);
      border: 1.5px solid var(--line);
    }
    .lbl {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--ink-soft);
    }
    fieldset {
      border: 1px solid var(--line);
      border-radius: var(--r-sm);
      padding: 8px 10px 10px;
      margin: 0;
    }
    legend {
      font-weight: 700;
      font-size: 0.9rem;
      padding: 0 4px;
    }
    .hint {
      font-size: 0.82rem;
      color: var(--ink-soft);
      margin: 0 0 8px;
    }
    .row2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
  `,
})
export class JumpEditor {
  private readonly store = inject(StoreService);
  readonly jump = input.required<JumpRecord>();
  readonly closed = output<void>();
  protected readonly units = computed(() => this.store.settings().units);

  protected readonly date = signal('');
  protected readonly tags = signal<string[]>([]);
  protected readonly note = signal('');
  protected readonly refValue = signal<number | null>(null);
  protected readonly refDevice = signal('');

  ngOnInit() {
    const j = this.jump();
    this.date.set(toLocal(j.date));
    this.tags.set(j.tags ?? []);
    this.note.set(j.note ?? '');
    this.refValue.set(j.reference ? Math.round(toUnits(j.reference.heightCm, this.units()) * 10) / 10 : null);
    this.refDevice.set(j.reference?.device ?? '');
  }

  protected save() {
    const d = new Date(this.date());
    const ref = Number(this.refValue());
    this.store.edit(this.jump().id, {
      date: isNaN(d.getTime()) ? this.jump().date : d.toISOString(),
      tags: this.tags().length ? this.tags() : undefined,
      note: this.note().trim() || undefined,
      reference: ref > 0 ? { heightCm: Math.round(fromUnits(ref, this.units()) * 10) / 10, device: this.refDevice().trim() || 'Other device' } : undefined,
    });
    this.closed.emit();
  }
}

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
