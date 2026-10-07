import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CloudService } from '../core/cloud.service';
import { StoreService } from '../core/store.service';
import { Avatar } from '../shared/avatar';

@Component({
  selector: 'app-account',
  imports: [FormsModule, RouterLink, DatePipe, Avatar],
  template: `
    <h1>Account</h1>

    @if (!cloud.configured) {
      <p>Cloud sync isn't set up for this copy of the app, so your jumps are saved on this phone only.</p>
    } @else if (!cloud.user()) {
      <section class="card">
        <p class="lede">
          Sign in to keep your jumps, settings and clips in the cloud, so they survive a lost phone and follow you to
          every device. Accounts are invite-only.
        </p>

        <div class="seg" role="tablist" aria-label="How to sign in">
          <button role="tab" type="button" [attr.aria-selected]="mode() === 'password'" [class.on]="mode() === 'password'" (click)="switchMode('password')">
            Password
          </button>
          <button role="tab" type="button" [attr.aria-selected]="mode() === 'code'" [class.on]="mode() === 'code'" (click)="switchMode('code')">
            Email code
          </button>
        </div>

        @if (cloud.linkError()) {
          <p class="error" role="alert">{{ cloud.linkError() }}</p>
        }

        @if (mode() === 'password') {
          <form (ngSubmit)="passwordSignIn()">
            <div class="field">
              <label for="ident">Email or username</label>
              <input id="ident" name="ident" autocomplete="username" autocapitalize="none" spellcheck="false" required [(ngModel)]="identifier" />
            </div>
            <div class="field">
              <label for="pw">Password</label>
              <input id="pw" name="pw" type="password" autocomplete="current-password" required [(ngModel)]="password" />
            </div>
            <button class="btn primary" type="submit" [disabled]="busy() || !identifier || !password">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
          </form>
          <p class="small muted">
            New here, or forgot your password?
            <button class="link" type="button" (click)="switchMode('code')">Sign in with an email code</button>, then set a
            password on this page.
          </p>
        } @else if (step() === 'email') {
          <form (ngSubmit)="send()">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" autocomplete="email" required [(ngModel)]="email" />
            </div>
            <button class="btn primary" type="submit" [disabled]="busy() || !email">{{ busy() ? 'Sending…' : 'Email me a sign-in code' }}</button>
          </form>
          <p class="small muted">First time? This creates your account if your email has been approved.</p>
        } @else {
          <form (ngSubmit)="verify()">
            <p>
              We emailed <strong>{{ email }}</strong>. Type the 6-digit code here, or tap the link in the email. It may take
              a minute, so check spam too.
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
          What's stored: your email, username, display name and picture, your jumps and their stats, your settings
          (including body mass and height if you entered them) and the clips you save. It's kept in a private database in
          the EU and only you can see it. You can delete all of it from this page.
        </p>
      </section>
    } @else {
      <section class="card profile">
        <div class="who">
          <label class="pic" [class.busy]="busy()">
            <app-avatar [src]="cloud.profile().avatarUrl" [name]="cloud.shownName()" [size]="84" />
            <input type="file" accept="image/*" (change)="pickAvatar($event)" class="sr-only" />
            <span class="change">Change</span>
          </label>
          <div>
            <p class="name">{{ cloud.shownName() }}</p>
            @if (cloud.profile().username) {
              <p class="muted">&#64;{{ cloud.profile().username }}</p>
            }
            <p class="muted small">{{ cloud.user()!.email }}</p>
            @if (cloud.profile().avatarUrl) {
              <button class="link" type="button" (click)="removeAvatar()">Remove picture</button>
            }
          </div>
        </div>

        @if (cloud.access() === 'revoked') {
          <p class="error">Your access has been removed by the admin. Your jumps are still on this phone.</p>
        } @else {
          @if (needsSetup()) {
            <p class="notice">Finish setting up: pick a username and a password so you can sign in without waiting for an email.</p>
          }

          <h2>Profile</h2>
          <form class="grid" (ngSubmit)="saveProfile()">
            <div class="field">
              <label for="dname">Display name</label>
              <input id="dname" name="dname" maxlength="60" autocomplete="name" [(ngModel)]="displayName" placeholder="e.g. Aldo" />
            </div>
            <div class="field">
              <label for="uname">Username</label>
              <input id="uname" name="uname" autocapitalize="none" spellcheck="false" autocomplete="username" maxlength="25" [(ngModel)]="username" placeholder="e.g. aldo.jumps" />
              <span class="hint">3–24 lowercase letters, numbers, dots or underscores. You can sign in with it.</span>
            </div>
            <div>
              <button class="btn" type="submit" [disabled]="busy()">Save profile</button>
            </div>
          </form>

          <h2>Password</h2>
          <form class="grid" (ngSubmit)="savePassword()">
            <!-- Lets password managers pair the new password with this account. -->
            <input type="text" name="username" autocomplete="username" [value]="cloud.user()!.email" class="sr-only" tabindex="-1" aria-hidden="true" />
            <div class="field">
              <label for="npw">New password</label>
              <input id="npw" name="npw" type="password" autocomplete="new-password" minlength="8" [(ngModel)]="newPassword" />
              <span class="hint">At least 8 characters. Sign in with your email or username plus this password.</span>
            </div>
            <div class="field">
              <label for="npw2">Repeat it</label>
              <input id="npw2" name="npw2" type="password" autocomplete="new-password" [(ngModel)]="newPassword2" />
            </div>
            <div>
              <button class="btn" type="submit" [disabled]="busy() || !newPassword">Set password</button>
            </div>
          </form>

          @if (notice()) {
            <p class="ok" role="status">{{ notice() }}</p>
          }
          @if (message()) {
            <p class="error" role="alert">{{ message() }}</p>
          }

          <h2>Sync</h2>
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
          <p class="small muted">{{ store.history().length }} jumps on this phone, {{ unsynced() }} waiting to upload.</p>
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
          Permanently deletes your account and everything stored in the cloud: jumps, settings, clips and profile. The
          jumps on this phone are kept unless you clear them yourself.
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
      </section>
    }
  `,
  styles: `
    .card {
      max-width: 36em;
    }
    .lede {
      font-size: 1.05rem;
    }
    form {
      display: grid;
      gap: 12px;
      margin: 12px 0;
    }
    h2 {
      margin-top: 28px;
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
    .ok {
      color: var(--ok);
      font-weight: 600;
    }
    .notice {
      padding: 10px 12px;
      border-left: 4px solid var(--blue);
      background: var(--surface);
      border-radius: var(--r-sm);
      font-weight: 600;
    }
    .link {
      border: 0;
      background: none;
      padding: 0;
      color: var(--blue);
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    .seg {
      display: inline-flex;
      border: 1.5px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      margin: 8px 0 4px;
      button {
        min-height: 40px;
        padding: 0 18px;
        border: 0;
        background: var(--surface);
        font-weight: 600;
        cursor: pointer;
        &.on {
          background: var(--ink);
          color: var(--paper);
        }
      }
    }
    .who {
      display: flex;
      align-items: center;
      gap: 16px;
      p {
        margin: 0;
      }
      .name {
        font-family: var(--display);
        font-weight: 700;
        font-size: 1.6rem;
        line-height: 1.1;
      }
    }
    .pic {
      position: relative;
      cursor: pointer;
      flex: none;
      .change {
        position: absolute;
        left: 50%;
        bottom: -6px;
        transform: translateX(-50%);
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--ink);
        color: var(--paper);
        font-size: 0.72rem;
        font-weight: 700;
      }
      &.busy {
        opacity: 0.5;
      }
      &:focus-within {
        outline: 3px solid var(--focus);
        outline-offset: 3px;
        border-radius: 50%;
      }
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
  protected readonly mode = signal<'password' | 'code'>('password');
  protected identifier = '';
  protected password = '';
  protected email = '';
  protected code = '';
  protected displayName = '';
  protected username = '';
  protected newPassword = '';
  protected newPassword2 = '';
  protected readonly step = signal<'email' | 'code'>('email');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly confirmDelete = signal(false);
  protected readonly unsynced = computed(() => this.store.history().filter((r) => !r.synced).length);
  protected readonly needsSetup = computed(() => this.cloud.signedIn() && !this.cloud.profile().username);

  constructor() {
    // Fill the profile form when the profile loads.
    effect(() => {
      const p = this.cloud.profile();
      this.displayName = p.displayName ?? '';
      this.username = p.username ?? '';
    });
  }

  protected switchMode(m: 'password' | 'code') {
    this.mode.set(m);
    this.message.set(null);
  }

  private async run(fn: () => Promise<string | void>) {
    this.busy.set(true);
    this.message.set(null);
    this.notice.set(null);
    try {
      const ok = await fn();
      if (ok) this.notice.set(ok);
    } catch (e) {
      this.message.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected passwordSignIn() {
    return this.run(async () => {
      await this.cloud.signInWithPassword(this.identifier, this.password);
      this.password = '';
    });
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

  protected saveProfile() {
    return this.run(async () => {
      await this.cloud.saveProfile({ username: this.username, displayName: this.displayName });
      return 'Profile saved.';
    });
  }

  protected savePassword() {
    return this.run(async () => {
      if (this.newPassword.length < 8) throw new Error('Use at least 8 characters.');
      if (this.newPassword !== this.newPassword2) throw new Error("The two passwords don't match.");
      await this.cloud.setPassword(this.newPassword);
      this.newPassword = this.newPassword2 = '';
      return 'Password set. You can now sign in with your email or username and this password.';
    });
  }

  protected pickAvatar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    return this.run(async () => {
      await this.cloud.setAvatar(file);
      return 'Picture updated.';
    });
  }

  protected removeAvatar() {
    return this.run(async () => {
      await this.cloud.removeAvatar();
      return 'Picture removed.';
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
