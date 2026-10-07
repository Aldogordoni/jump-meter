import { Component, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Comment, SquadService } from '../core/squad.service';

/** Comment thread on one jump: the athlete and their coaches. */
@Component({
  selector: 'app-comments',
  imports: [DatePipe, FormsModule],
  template: `
    <section class="thread" [attr.aria-label]="'Comments on this jump'">
      @if (loading()) {
        <p class="small muted">Loading comments…</p>
      } @else {
        @if (!items().length) {
          <p class="small muted">No comments yet.@if (hint()) { {{ hint() }}}</p>
        }
        <ul aria-live="polite">
          @for (c of items(); track c.id) {
            <li>
              <div class="head">
                <strong>{{ c.author }}</strong>
                <span class="small muted">{{ c.createdAt | date: 'd MMM, HH:mm' }}</span>
                @if (c.mine || canModerate()) {
                  <button class="link" type="button" (click)="remove(c)" [attr.aria-label]="'Delete comment by ' + c.author">Delete</button>
                }
              </div>
              <p>{{ c.body }}</p>
            </li>
          }
        </ul>
      }
      <form (ngSubmit)="add()" class="add">
        <label class="sr-only" [for]="'c-' + jumpId()">Add a comment</label>
        <textarea
          [id]="'c-' + jumpId()"
          name="body"
          rows="2"
          maxlength="1000"
          placeholder="Add a comment"
          [(ngModel)]="draft"
          (keydown.control.enter)="add()"
          (keydown.meta.enter)="add()"
        ></textarea>
        <button class="btn" type="submit" [disabled]="!draft.trim() || busy()">{{ busy() ? 'Posting…' : 'Post' }}</button>
      </form>
      @if (error()) {
        <p class="small err" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: `
    .thread {
      display: grid;
      gap: 8px;
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: var(--r-sm);
      border: 1px solid var(--line);
      background: var(--surface);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;
    }
    li p {
      margin: 2px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .add {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    textarea {
      width: 100%;
      font: inherit;
      padding: 8px 10px;
      border-radius: var(--r-sm);
      border: 1.5px solid var(--line);
      background: var(--paper);
      color: var(--ink);
      resize: vertical;
    }
    .link {
      border: 0;
      background: none;
      color: var(--blue);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
      font-size: 0.85rem;
      padding: 0;
    }
    .err {
      color: var(--red);
      margin: 0;
    }
  `,
})
export class Comments {
  private readonly squads = inject(SquadService);
  readonly jumpId = input.required<string>();
  /** The jump's owner can remove any comment on it. */
  readonly canModerate = input(false);
  readonly hint = input<string | null>(null);
  readonly count = output<number>();

  protected readonly items = signal<Comment[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected draft = '';

  ngOnInit() {
    this.load();
  }

  private async load() {
    try {
      const list = await this.squads.comments(this.jumpId());
      this.items.set(list);
      this.count.emit(list.length);
    } catch {
      this.error.set("Couldn't load comments. Check your connection.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async add() {
    const body = this.draft.trim();
    if (!body || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.squads.addComment(this.jumpId(), body);
      this.draft = '';
      await this.load();
    } catch {
      this.error.set("Couldn't post the comment. Is this jump backed up to your account yet?");
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(c: Comment) {
    try {
      await this.squads.deleteComment(c.id);
      await this.load();
    } catch {
      this.error.set("Couldn't delete the comment.");
    }
  }
}
