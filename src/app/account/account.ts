import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CloudService } from '../core/cloud.service';
import { StoreService } from '../core/store.service';

@Component({
  selector: 'app-account',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <h1>Account</h1>

    @if (!cloud.configured) {
      <p>Cloud sync isn't set up for this copy of the app, so your jumps are saved on this phone only.</p>
    } @else if (!cloud.user()) {
      <section class="card">
        <h2>Sign in</h2>
        <p>
          Sign in to keep your jumps, settings and video clips in the cloud, so they survive a lost phone and show up on
          all your devices. Accounts are invite-only: only emails approved by the admin can sign in.
        </p>
        @if (cloud.linkError()) {
          <p class="error" role="alert">{{ cloud.linkError() }}</p>
        }
        @if (step() === 'email') {
          <form (ngSubmit)="send()">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" autocomplete="email" required [(ngModel)]="email" />
            </div>
            <button class="btn primary" type="submit" [disabled]="busy() || !email">{{ busy() ? 'Sending…' : 'Email me a sign-in code' }}</button>
          </form>
        } @else {
          <form (ngSubmit)="verify()">
            <p>
              We emailed <strong>{{ email }}</strong>. Type the 6-digit code here, or tap the link in the email. It may
              take a minute, so check spam too.
            </p>
            <div class="field">
              <label for="code">Code</label>
              <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required [(ngModel)]="code" />
            </div>
            <div class="row">
              <button class="btn primary" type="submit" [disabled]="busy() || code.length < 6">{{ busy() ? 'Checking…' : 'Sign in' }}</button>
              <button class="btn ghost" type="button" (click)="step.set('email'); code = ''">Use a different email</button>
            </div>
          </form>
        }
        @if (message()) {
          <p class="error" role="alert">{{ message() }}</p>
        }
        <p class="small muted">
          What's stored: your email, your jumps and their stats, your settings (including body mass and height if you
          entered them) and any clips you save. It's kept in a database in London and only you can see it. You can
          delete all of it from this page at any time.
        </p>
      </section>
    } @else {
      <section class="card">
        <p class="who">Signed in as <strong>{{ cloud.user()!.email }}</strong></p>

        @if (cloud.access() === 'revoked') {
          <p class="error">Your access has been removed by the admin. Your jumps are still on this phone.</p>
        } @else {
          <p class="status" [class]="'status ' + cloud.status()">
            @switch (cloud.status()) {
              @case ('syncing') { Syncing… }
              @case ('offline') { Offline. Changes will sync when you're back online. }
              @case ('error') { Sync problem: {{ cloud.error() }} }
              @default {
                Synced
                @if (cloud.lastSync()) { {{ cloud.lastSync() | date: 'd MMM, HH:mm' }} }
              }
            }
          </p>
          <p class="small muted">
            {{ store.history().length }} jumps on this phone, {{ unsynced() }} waiting to upload.
          </p>
          <div class="row">
            <button class="btn" type="button" (click)="cloud.syncNow()" [disabled]="cloud.status() === 'syncing'">Sync now</button>
            @if (cloud.isAdmin()) {
              <a class="btn" routerLink="/admin">Manage approved emails</a>
            }
          </div>
        }

        <h2>Sign out</h2>
        <div class="row">
          <button class="btn" type="button" (click)="signOut(false)">Sign out</button>
          <button class="btn" type="button" (click)="signOut(true)">Sign out and remove jumps from this phone</button>
        </div>
        <p class="small muted">Use the second option on a shared or borrowed phone. Your jumps stay safe in the cloud.</p>

        <h2>Delete account</h2>
        <p class="small">
          Permanently deletes your account and everything stored in the cloud: jumps, settings and clips. The jumps on
          this phone are kept unless you clear them yourself.
        </p>
        @if (!confirmDelete()) {
          <button class="btn danger" type="button" (click)="confirmDelete.set(true)">Delete my cloud account</button>
        } @else {
          <div class="row">
            <button class="btn danger" type="button" (click)="deleteAccount()" [disabled]="busy()">
              {{ busy() ? 'Deleting…' : 'Yes, delete everything in the cloud' }}
            </button>
            <button class="btn ghost" type="button" (click)="confirmDelete.set(false)">Cancel</button>
          </div>
        }
        @if (message()) {
          <p class="error" role="alert">{{ message() }}</p>
        }
      </section>
    }
  `,
  styles: `
    .card {
      max-width: 36em;
    }
    form {
      display: grid;
      gap: 12px;
      margin: 12px 0;
    }
    h2 {
      margin-top: 24px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .small {
      font-size: 0.88rem;
    }
    .error {
      color: var(--red);
      font-weight: 600;
    }
    .status {
      font-weight: 700;
      margin-bottom: 4px;
      &.idle {
        color: var(--ok);
      }
      &.error {
        color: var(--red);
      }
    }
  `,
})
export class Account {
  protected readonly cloud = inject(CloudService);
  protected readonly store = inject(StoreService);
  protected email = '';
  protected code = '';
  protected readonly step = signal<'email' | 'code'>('email');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly confirmDelete = signal(false);
  protected readonly unsynced = computed(() => this.store.history().filter((r) => !r.synced).length);

  private async run(fn: () => Promise<void>) {
    this.busy.set(true);
    this.message.set(null);
    try {
      await fn();
    } catch (e) {
      this.message.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected send() {
    return this.run(async () => {
      await this.cloud.sendCode(this.email);
      this.step.set('code');
    });
  }

  protected verify() {
    return this.run(async () => {
      await this.cloud.verifyCode(this.email, this.code);
      this.code = '';
      this.step.set('email');
    });
  }

  protected signOut(removeLocal: boolean) {
    return this.run(() => this.cloud.signOut(removeLocal));
  }

  protected deleteAccount() {
    return this.run(async () => {
      await this.cloud.deleteAccount();
      this.confirmDelete.set(false);
    });
  }
}
