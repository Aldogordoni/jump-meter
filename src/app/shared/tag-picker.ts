import { Component, computed, inject, input, output, signal } from '@angular/core';
import { StoreService } from '../core/store.service';

export const BUILT_IN_TAGS = [
  'Warm-up done',
  'No warm-up',
  'Trainers',
  'Barefoot',
  'Indoor',
  'Outdoor',
  'Morning',
  'Evening',
  'Good sleep',
  'Poor sleep',
  'Sore legs',
  'After training',
];

/** Toggle chips for context tags, plus "add your own". */
@Component({
  selector: 'app-tag-picker',
  template: `
    <div class="tags" role="group" [attr.aria-label]="label()">
      @for (t of all(); track t) {
        <button type="button" [class.on]="selected().includes(t)" [attr.aria-pressed]="selected().includes(t)" (click)="toggle(t)">
          {{ t }}
        </button>
      }
      @if (adding()) {
        <input
          #box
          class="add-input"
          maxlength="24"
          placeholder="New tag"
          aria-label="New tag"
          (keydown.enter)="$event.preventDefault(); add(box.value)"
          (blur)="add(box.value)"
        />
      } @else {
        <button type="button" class="add" (click)="adding.set(true)">+ Tag</button>
      }
    </div>
  `,
  styles: `
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    button {
      min-height: 34px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1.5px solid var(--line);
      background: var(--surface);
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      color: var(--ink);
      &.on {
        background: var(--ink);
        border-color: var(--ink);
        color: var(--paper);
      }
      &.add {
        border-style: dashed;
        color: var(--ink-soft);
      }
    }
    .add-input {
      min-height: 34px;
      width: 9em;
      padding: 0 10px;
      border-radius: 999px;
      border: 1.5px solid var(--blue);
      background: var(--surface);
    }
  `,
})
export class TagPicker {
  private readonly store = inject(StoreService);
  readonly selected = input<string[]>([]);
  readonly label = input('Tags');
  readonly changed = output<string[]>();
  protected readonly adding = signal(false);

  protected readonly all = computed(() => {
    const extra = [...this.store.settings().customTags, ...this.selected()];
    return [...new Set([...BUILT_IN_TAGS, ...extra])];
  });

  protected toggle(t: string) {
    const s = this.selected();
    this.changed.emit(s.includes(t) ? s.filter((x) => x !== t) : [...s, t]);
  }

  protected add(raw: string) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 24);
    this.adding.set(false);
    if (!t) return;
    if (!BUILT_IN_TAGS.includes(t) && !this.store.settings().customTags.includes(t)) {
      this.store.updateSettings({ customTags: [...this.store.settings().customTags, t] });
    }
    if (!this.selected().includes(t)) this.changed.emit([...this.selected(), t]);
  }
}
