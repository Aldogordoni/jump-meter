import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { CloudService } from './core/cloud.service';
import { Avatar } from './shared/avatar';
import { Onboarding } from './shared/onboarding';
import { StoreService } from './core/store.service';
import { HousekeepingService } from './core/housekeeping.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Avatar, Onboarding],
  template: `
    <a class="skip" href="#main" (click)="skip($event)">Skip to content</a>
    <header class="top">
      <a routerLink="/measure" class="mark" aria-label="Jump Meter home">
        <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
          <rect x="3" y="3" width="13" height="3" rx="1" fill="var(--red)" />
          <rect x="3" y="8" width="16" height="3" rx="1" fill="currentColor" opacity=".35" />
          <rect x="3" y="13" width="18" height="3" rx="1" fill="var(--blue)" />
          <rect x="3" y="18" width="16" height="3" rx="1" fill="currentColor" opacity=".35" />
        </svg>
        Jump Meter
      </a>
      @if (cloud.configured) {
        <a routerLink="/account" class="acct" [class]="'acct ' + cloud.status() + (cloud.user() ? ' in' : '')" [attr.aria-label]="accountLabel()">
          @if (cloud.user()) {
            <span class="dot" aria-hidden="true"></span>
            <app-avatar [src]="cloud.profile().avatarUrl" [name]="cloud.shownName()" [size]="30" />
          } @else {
            Sign in
          }
        </a>
      }
    </header>
    <main id="main" tabindex="-1">
      <router-outlet />
    </main>
    <nav class="tabs" aria-label="Sections">
      <a routerLink="/measure" routerLinkActive="on" ariaCurrentWhenActive="page">Measure</a>
      <a routerLink="/history" routerLinkActive="on" ariaCurrentWhenActive="page">History</a>
      <a routerLink="/train" routerLinkActive="on" ariaCurrentWhenActive="page">Train</a>
      @if (cloud.signedIn()) {
        <a routerLink="/team" routerLinkActive="on" ariaCurrentWhenActive="page">Team</a>
      }
      <a routerLink="/setup" routerLinkActive="on" ariaCurrentWhenActive="page">Setup</a>
    </nav>
    @if (toast(); as t) {
      <div class="toast" role="status">
        {{ t.text }}
        <a [routerLink]="t.link" (click)="toast.set(null)">Open</a>
        <button type="button" class="x" (click)="toast.set(null)" aria-label="Dismiss">×</button>
      </div>
    }
    @if (showOnboarding()) {
      <app-onboarding />
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      padding-bottom: calc(64px + env(safe-area-inset-bottom));
    }
    .toast {
      position: fixed;
      left: 12px;
      right: 12px;
      bottom: calc(70px + env(safe-area-inset-bottom));
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: var(--r-lg);
      background: var(--ink);
      color: var(--paper);
      font-weight: 600;
      a {
        color: var(--paper);
        margin-left: auto;
      }
      .x {
        border: 0;
        background: none;
        color: var(--paper);
        font-size: 1.4rem;
        min-width: 32px;
        min-height: 32px;
        cursor: pointer;
      }
    }
    .skip {
      position: absolute;
      left: 8px;
      top: -60px;
      z-index: 60;
      padding: 8px 14px;
      background: var(--ink);
      color: var(--paper);
      border-radius: var(--r-sm);
      &:focus {
        top: 8px;
      }
    }
    main:focus {
      outline: none;
    }
    .top {
      padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
      max-width: 760px;
      margin: 0 auto;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .acct {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 40px;
      padding: 0 12px;
      &.in {
        padding: 0 4px 0 12px;
      }
      border: 1.5px solid var(--line);
      border-radius: 999px;
      color: var(--ink);
      text-decoration: none;
      font-weight: 600;
      .initial {
        font-family: var(--display);
        font-size: 1.1rem;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--ink-soft);
      }
      &.idle .dot {
        background: var(--ok);
      }
      &.syncing .dot {
        background: var(--blue);
      }
      &.error .dot,
      &.offline .dot {
        background: var(--red);
      }
    }
    .mark {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--display);
      font-weight: 700;
      font-size: 1.35rem;
      color: var(--ink);
      text-decoration: none;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 16px 24px;
    }
    .tabs {
      position: fixed;
      inset: auto 0 0 0;
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      background: var(--surface);
      border-top: 1.5px solid var(--line);
      padding-bottom: env(safe-area-inset-bottom);
      z-index: 10;
    }
    .tabs a {
      display: grid;
      place-items: center;
      height: 56px;
      font-family: var(--display);
      font-weight: 600;
      font-size: 1.1rem;
      color: var(--ink-soft);
      text-decoration: none;
      border-top: 3px solid transparent;
      margin-top: -1.5px;
    }
    .tabs a.on {
      color: var(--ink);
      border-top-color: var(--red);
    }
  `,
})
export class App {
  protected readonly cloud = inject(CloudService);
  private readonly store = inject(StoreService);
  /** First-run guide, for new users only (people with saved jumps already know the app). */
  protected readonly showOnboarding = computed(
    () => !this.store.settings().onboarded && !this.store.history().length && !location.hash.includes('access_token'),
  );

  protected readonly toast = signal<{ text: string; link: string } | null>(null);
  private toastTimer?: ReturnType<typeof setTimeout>;

  protected skip(e: Event) {
    e.preventDefault();
    document.getElementById('main')?.focus();
  }
  protected accountLabel() {
    const u = this.cloud.user();
    if (!u) return 'Sign in to sync your jumps';
    const s = this.cloud.status();
    return `Account: ${this.cloud.shownName()}, ${s === 'idle' ? 'synced' : s}`;
  }

  constructor() {
    // A coach (or athlete) commented: say so, wherever you are in the app.
    effect(() => {
      const ping = this.cloud.commentPing();
      if (!ping) return;
      untracked(() => {
        const mine = this.store.history().some((r) => r.id === ping.jumpId);
        this.toast.set({ text: mine ? 'New comment on one of your jumps' : 'New comment in your squad', link: mine ? '/history' : '/team' });
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.toast.set(null), 8000);
      });
    });
    if (!this.store.settings().onboarded && this.store.history().length) this.store.updateSettings({ onboarded: true });
    // Old clips go once a day, a little after start-up.
    const housekeeping = inject(HousekeepingService);
    setTimeout(() => housekeeping.run().catch(() => undefined), 15000);
    this.cloud.init().catch((e) => console.warn('[jump-meter] cloud init failed', e));
    // Apply new versions straight away, so fixes reach the installed app without a double refresh.
    const sw = inject(SwUpdate);
    if (sw.isEnabled) {
      sw.versionUpdates.subscribe((e) => {
        if (e.type === 'VERSION_READY' && !document.querySelector('app-measure canvas')) location.reload();
      });
      sw.checkForUpdate().catch(() => undefined);
    }
  }
}
