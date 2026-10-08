import { ErrorHandler, Injectable, inject } from '@angular/core';
import { CloudService } from './cloud.service';
import { APP_VERSION } from './version';

const QUEUE_KEY = 'jump-meter.errors';
const MAX_QUEUE = 20;

interface QueuedError {
  at: string;
  message: string;
  stack: string | null;
  path: string;
}

/** Strip anything that could identify a person or leak a token. */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(access_token|refresh_token|token|apikey|key)=[^&\s"']+/gi, '$1=<redacted>')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
    .replace(/https:\/\/[\w.-]+\.supabase\.co\/storage\/v1\/object\/sign\/\S+/g, '<signed-url>');
}

/**
 * Collects unexpected errors and, for signed-in users, stores them in the project's own
 * database (table client_errors), so problems on someone's phone show up on the admin page.
 * No third-party service; messages are scrubbed of emails and tokens.
 */
@Injectable({ providedIn: 'root' })
export class ErrorReporter implements ErrorHandler {
  private readonly cloud = inject(CloudService);
  private flushing = false;
  private recent = new Map<string, number>();

  constructor() {
    setInterval(() => this.flush(), 60_000);
  }

  handleError(error: unknown): void {
    console.error(error);
    try {
      const e = (error as { rejection?: unknown })?.rejection ?? error;
      const err = e instanceof Error ? e : new Error(String((e as { message?: string })?.message ?? e));
      if (err.name === 'AbortError') return;
      const message = scrub(`${err.name}: ${err.message}`).slice(0, 500);
      // Same error within ten minutes: count once.
      const last = this.recent.get(message);
      if (last && Date.now() - last < 600_000) return;
      this.recent.set(message, Date.now());
      const queue = this.read();
      queue.push({
        at: new Date().toISOString(),
        message,
        stack: err.stack ? scrub(err.stack).slice(0, 4000) : null,
        path: location.hash.split('?')[0].slice(0, 200) || '/',
      });
      this.write(queue.slice(-MAX_QUEUE));
      setTimeout(() => this.flush(), 2000);
    } catch {
      /* never let reporting break the app */
    }
  }

  async flush() {
    if (this.flushing || !this.cloud.signedIn() || !navigator.onLine) return;
    const queue = this.read();
    if (!queue.length) return;
    this.flushing = true;
    try {
      const sb = await this.cloud.api();
      const ua = navigator.userAgent.slice(0, 300);
      const { error } = await sb.from('client_errors').insert(
        queue.map((q) => ({ at: q.at, message: q.message, stack: q.stack, path: q.path, app_version: APP_VERSION, user_agent: ua })),
      );
      // Over the daily limit or rejected: drop them rather than retry forever.
      if (!error || error.code === '42501') this.write([]);
    } catch {
      /* try again later */
    } finally {
      this.flushing = false;
    }
  }

  private read(): QueuedError[] {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  private write(q: QueuedError[]) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    } catch {
      /* full or blocked */
    }
  }
}
