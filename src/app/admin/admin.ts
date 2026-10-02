import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AllowedEmail, CloudService } from '../core/cloud.service';

@Component({
  selector: 'app-admin',
  imports: [FormsModule, DatePipe, RouterLink],
  template: `
    <h1>Approved emails</h1>

    @if (!cloud.isAdmin()) {
      <p>Only admins can see this page. <a routerLink="/account">Back to account</a></p>
    } @else {
      <p>
        Only these emails can create an account. Removing someone cuts off their access straight away. Their data stays
        in the database until they delete it, or you delete it in Supabase.
      </p>

      <form class="add" (ngSubmit)="add()">
        <div class="field">
          <label for="new-email">Email</label>
          <input id="new-email" name="email" type="email" required [(ngModel)]="email" placeholder="name@example.com" />
        </div>
        <div class="field">
          <label for="new-note">Note</label>
          <input id="new-note" name="note" type="text" [(ngModel)]="note" placeholder="Optional, e.g. teammate" />
        </div>
        <label class="check">
          <input type="checkbox" name="admin" [(ngModel)]="makeAdmin" />
          Can manage this list
        </label>
        <button class="btn primary" type="submit" [disabled]="busy() || !email">Approve email</button>
      </form>

      @if (message()) {
        <p class="msg" [class.error]="isError()" role="status">{{ message() }}</p>
      }

      <ul class="list">
        @for (a of list(); track a.email) {
          <li>
            <div>
              <strong>{{ a.email }}</strong>
              @if (a.is_admin) {
                <span class="badge">Admin</span>
              }
              @if (a.email === me()) {
                <span class="badge you">You</span>
              }
              <span class="meta">
                Added {{ a.added_at | date: 'd MMM yyyy' }}@if (a.note) {, {{ a.note }}}
              </span>
            </div>
            <div class="actions">
              <button class="btn ghost" type="button" (click)="toggleAdmin(a)" [disabled]="busy()">
                {{ a.is_admin ? 'Remove admin' : 'Make admin' }}
              </button>
              @if (confirming() === a.email) {
                <button class="btn danger" type="button" (click)="remove(a)" [disabled]="busy()">Confirm remove</button>
              } @else {
                <button class="btn ghost del" type="button" (click)="confirming.set(a.email)" [disabled]="a.email === me()">
                  Remove
                </button>
              }
            </div>
          </li>
        } @empty {
          <li class="muted">{{ busy() ? 'Loading…' : 'No emails yet.' }}</li>
        }
      </ul>
    }
  `,
  styles: `
    .add {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      align-items: end;
      margin: 16px 0;
      max-width: 40em;
      .check {
        display: flex;
        gap: 8px;
        align-items: center;
        min-height: 44px;
      }
    }
    .list {
      list-style: none;
      padding: 0;
      margin: 0;
      li {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 0;
        border-top: 1px solid var(--line);
      }
      .meta {
        display: block;
        font-size: 0.85rem;
        color: var(--ink-soft);
      }
      .actions {
        display: flex;
        gap: 4px;
      }
      .del {
        color: var(--red);
      }
    }
    .badge {
      margin-left: 6px;
      padding: 1px 8px;
      border-radius: 999px;
      background: var(--blue);
      color: var(--blue-ink);
      font-size: 0.75rem;
      font-weight: 700;
      &.you {
        background: var(--ink);
        color: var(--paper);
      }
    }
    .msg {
      font-weight: 600;
      color: var(--ok);
      &.error {
        color: var(--red);
      }
    }
    @media (max-width: 520px) {
      .add {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class Admin implements OnInit {
  protected readonly cloud = inject(CloudService);
  protected readonly list = signal<AllowedEmail[]>([]);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly isError = signal(false);
  protected readonly confirming = signal<string | null>(null);
  protected readonly me = () => this.cloud.user()?.email.toLowerCase();
  protected email = '';
  protected note = '';
  protected makeAdmin = false;

  ngOnInit() {
    this.refresh();
  }

  private async run(fn: () => Promise<string | void>) {
    this.busy.set(true);
    this.message.set(null);
    try {
      const ok = await fn();
      if (ok) {
        this.message.set(ok);
        this.isError.set(false);
      }
      this.list.set(await this.cloud.listAllowed());
    } catch (e) {
      this.message.set((e as Error).message);
      this.isError.set(true);
    } finally {
      this.busy.set(false);
      this.confirming.set(null);
    }
  }

  protected refresh() {
    return this.run(async () => undefined);
  }

  protected add() {
    return this.run(async () => {
      const email = this.email.trim().toLowerCase();
      await this.cloud.addAllowed(email, this.makeAdmin, this.note);
      this.email = '';
      this.note = '';
      this.makeAdmin = false;
      return `Approved ${email}. They can now sign in from the Account page.`;
    });
  }

  protected remove(a: AllowedEmail) {
    return this.run(async () => {
      await this.cloud.removeAllowed(a.email);
      return `Removed ${a.email}.`;
    });
  }

  protected toggleAdmin(a: AllowedEmail) {
    return this.run(async () => {
      await this.cloud.setAdmin(a.email, !a.is_admin);
      return a.is_admin ? `${a.email} is no longer an admin.` : `${a.email} is now an admin.`;
    });
  }
}
