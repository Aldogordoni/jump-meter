import { Component, computed, input } from '@angular/core';

/** Round profile picture, falling back to the first letter of the name. */
@Component({
  selector: 'app-avatar',
  template: `
    @if (src()) {
      <img [src]="src()" alt="" [style.width.px]="size()" [style.height.px]="size()" />
    } @else {
      <span class="initial" [style.width.px]="size()" [style.height.px]="size()" [style.font-size.px]="size() * 0.45">{{ initial() }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    img,
    .initial {
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      object-fit: cover;
      background: var(--blue);
      color: var(--blue-ink);
      font-family: var(--display);
      font-weight: 700;
    }
  `,
})
export class Avatar {
  readonly src = input<string | null>(null);
  readonly name = input('');
  readonly size = input(32);
  protected readonly initial = computed(() => (this.name().replace(/^@/, '').charAt(0) || '?').toUpperCase());
}
