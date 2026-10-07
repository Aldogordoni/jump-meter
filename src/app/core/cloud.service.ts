import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, cloudConfigured } from './cloud.config';
import { StoreService, Settings, isUuid, uuid } from './store.service';
import { JumpRecord, JumpType } from './jump-math';
import { clipStore, StoredClip } from './clip-store';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

export interface Profile {
  username: string | null;
  displayName: string | null;
  /** Data URL of the profile picture (cached on the device). */
  avatarUrl: string | null;
}

export interface AllowedEmail {
  email: string;
  is_admin: boolean;
  note: string | null;
  added_at: string;
}

interface JumpRow {
  id: string;
  jumped_at: string;
  type: string;
  height_cm: number;
  flight_ms: number;
  capture_fps: number;
  frames: number;
  method: string;
  note: string | null;
  contact_ms: number | null;
  rsi: number | null;
  box_cm: number | null;
  time_to_takeoff_ms: number | null;
  rsi_mod: number | null;
  has_clip: boolean;
}

const DELETES_KEY = 'jump-meter.cloud.pending-deletes';
const LAST_SYNC_KEY = 'jump-meter.cloud.last-sync';
const BUCKET = 'clips';
/** Deletions wait out the undo window before reaching the cloud. */
const DELETE_DELAY_MS = 7000;

/**
 * Keeps the local store in step with Supabase. The phone stays the working copy
 * (works offline); the cloud is the long-term record across devices.
 */
@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly store = inject(StoreService);

  readonly configured = cloudConfigured();
  readonly user = signal<{ id: string; email: string } | null>(null);
  /** Whitelist state for the signed-in user. */
  readonly access = signal<'unknown' | 'allowed' | 'revoked'>('unknown');
  readonly isAdmin = signal(false);
  readonly status = signal<SyncStatus>('off');
  readonly error = signal<string | null>(null);
  readonly lastSync = signal<string | null>(readLocal(LAST_SYNC_KEY));
  readonly signedIn = computed(() => !!this.user() && this.access() === 'allowed');
  /** Public-facing profile: username, display name and picture. */
  readonly profile = signal<Profile>({ username: null, displayName: null, avatarUrl: null });
  /** Name to show in the app: display name, then @username, then email. */
  readonly shownName = computed(() => {
    const p = this.profile();
    return p.displayName || (p.username ? '@' + p.username : (this.user()?.email ?? ''));
  });

  private client?: Promise<SupabaseClient>;
  private syncing = false;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private deletes = new Map<string, number>(Object.entries(readJson<Record<string, number>>(DELETES_KEY, {})));
  /** Settings pushes only start after the first pull, so a fresh device doesn't overwrite the cloud. */
  private settingsReady = false;

  constructor() {
    if (!this.configured) return;
    this.store.onChange(() => this.schedule(500));
    let settingsTimer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const s = this.store.settings();
      if (!this.signedIn()) return;
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(() => untracked(() => this.settingsReady && this.pushSettings(s)), 1200);
    });
    addEventListener('online', () => this.schedule(0));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.schedule(0));
  }

  /** Start up: restore the session if there is one. */
  async init() {
    if (!this.configured) return;
    const sb = await this.sb();
    await this.consumeAuthRedirect(sb);
    const { data } = await sb.auth.getSession();
    if (data.session?.user) await this.onSignedIn(data.session.user);
    else this.status.set('off');
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') this.onSignedOut();
      else if (session?.user && session.user.id !== this.user()?.id) {
        // Supabase recommends not awaiting other calls inside this callback.
        setTimeout(() => this.onSignedIn(session.user));
      }
    });
  }

  /** Finish a sign-in that arrived through an email link (tokens stashed by main.ts). */
  private async consumeAuthRedirect(sb: SupabaseClient) {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem('jump-meter.auth-redirect');
      sessionStorage.removeItem('jump-meter.auth-redirect');
    } catch {
      return;
    }
    if (!raw) return;
    const p = new URLSearchParams(raw);
    const err = p.get('error_description');
    if (err) {
      this.linkError.set(/expired|invalid/i.test(err) ? 'That sign-in link has expired or was already used. Request a new code.' : err);
      return;
    }
    const access_token = p.get('access_token');
    const refresh_token = p.get('refresh_token');
    if (access_token && refresh_token) {
      const { error } = await sb.auth.setSession({ access_token, refresh_token });
      if (error) this.linkError.set(friendlyAuthError(error.message));
    }
  }

  /** Error from a sign-in link, shown on the Account page. */
  readonly linkError = signal<string | null>(null);

  private sb(): Promise<SupabaseClient> {
    this.client ??= import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'jump-meter.auth' },
      }),
    );
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  async sendCode(email: string): Promise<void> {
    const sb = await this.sb();
    const { error } = await sb.auth.signInWithOtp({
      email: normaliseEmail(email),
      // If the email contains a link rather than a code, bring the user back to this app.
      options: { shouldCreateUser: true, emailRedirectTo: appUrl() },
    });
    if (error) throw new Error(friendlyAuthError(error.message));
  }

  async verifyCode(email: string, code: string): Promise<void> {
    const sb = await this.sb();
    const { data, error } = await sb.auth.verifyOtp({
      email: normaliseEmail(email),
      token: code.replace(/\s/g, ''),
      type: 'email',
    });
    if (error) throw new Error(friendlyAuthError(error.message));
    if (data.user) await this.onSignedIn(data.user);
  }

  /** Sign in with email or username, plus password. */
  async signInWithPassword(identifier: string, password: string): Promise<void> {
    const sb = await this.sb();
    // "@name" is a username; only "name@domain" is an email.
    const id = identifier.trim().replace(/^@+/, '');
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) {
      const { data, error } = await sb.auth.signInWithPassword({ email: normaliseEmail(id), password });
      if (error) throw new Error(friendlyAuthError(error.message));
      if (data.user) await this.onSignedIn(data.user);
      return;
    }
    // Usernames are resolved on the server so emails never reach the browser.
    let res: Response;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/username-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ username: id.toLowerCase(), password }),
      });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection.");
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Too many wrong attempts for this username. Try again in 15 minutes, or sign in with an email code.');
    if (!res.ok || !body.access_token) throw new Error('Wrong username or password.');
    const { data, error } = await sb.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
    if (error) throw new Error(friendlyAuthError(error.message));
    if (data.user) await this.onSignedIn(data.user);
  }

  /** Set or change the password for the signed-in account. */
  async setPassword(password: string): Promise<void> {
    const sb = await this.sb();
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new Error(friendlyAuthError(error.message));
  }

  async saveProfile(changes: { username: string; displayName: string }): Promise<void> {
    const u = this.user();
    if (!u) return;
    const username = changes.username.trim().replace(/^@/, '').toLowerCase() || null;
    if (username && !/^[a-z0-9_.]{3,24}$/.test(username)) {
      throw new Error('Usernames are 3–24 characters: lowercase letters, numbers, dots and underscores.');
    }
    const displayName = changes.displayName.trim().slice(0, 60) || null;
    const sb = await this.sb();
    const { error } = await sb
      .from('profiles')
      .upsert({ user_id: u.id, username, display_name: displayName, updated_at: new Date().toISOString() });
    if (error) {
      if (/duplicate key|profiles_username_key/.test(error.message)) throw new Error('That username is taken.');
      throw new Error(friendlyDbError(error.message));
    }
    this.profile.update((p) => ({ ...p, username, displayName }));
  }

  /** Resize to a 256 px square JPEG and store it with the user's files. */
  async setAvatar(file: File): Promise<void> {
    const u = this.user();
    if (!u) return;
    const blob = await squareJpeg(file, 256);
    const sb = await this.sb();
    const path = `${u.id}/avatar.jpg`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (up.error) throw new Error(up.error.message);
    const { error } = await sb.from('profiles').upsert({ user_id: u.id, avatar_path: path, updated_at: new Date().toISOString() });
    if (error) throw new Error(friendlyDbError(error.message));
    const url = await blobToDataUrl(blob);
    writeLocal(avatarKey(u.id), url);
    this.profile.update((p) => ({ ...p, avatarUrl: url }));
  }

  async removeAvatar(): Promise<void> {
    const u = this.user();
    if (!u) return;
    const sb = await this.sb();
    await sb.storage.from(BUCKET).remove([`${u.id}/avatar.jpg`]);
    await sb.from('profiles').upsert({ user_id: u.id, avatar_path: null, updated_at: new Date().toISOString() });
    try {
      localStorage.removeItem(avatarKey(u.id));
    } catch {
      /* ignore */
    }
    this.profile.update((p) => ({ ...p, avatarUrl: null }));
  }

  async signOut(removeLocal: boolean) {
    const sb = await this.sb();
    await this.syncNow().catch(() => undefined);
    await sb.auth.signOut();
    this.onSignedOut();
    if (removeLocal) {
      const ids = this.store.history().map((r) => r.id);
      this.store.removeIds(ids);
      await Promise.all(ids.map((id) => clipStore.delete(id).catch(() => undefined)));
    }
  }

  private async onSignedIn(user: User) {
    this.user.set({ id: user.id, email: user.email ?? '' });
    this.profile.update((p) => ({ ...p, avatarUrl: readLocal(avatarKey(user.id)) }));
    this.error.set(null);
    const sb = await this.sb();
    const [allowed, admin] = await Promise.all([sb.rpc('is_allowed'), sb.rpc('is_admin')]);
    if (allowed.error) {
      this.status.set(isNetworkError(allowed.error) ? 'offline' : 'error');
      this.error.set(isNetworkError(allowed.error) ? null : allowed.error.message);
      return;
    }
    this.access.set(allowed.data ? 'allowed' : 'revoked');
    this.isAdmin.set(!!admin.data);
    if (allowed.data) await this.syncNow();
    else this.status.set('off');
  }

  private onSignedOut() {
    this.user.set(null);
    this.profile.set({ username: null, displayName: null, avatarUrl: null });
    this.access.set('unknown');
    this.isAdmin.set(false);
    this.status.set('off');
    this.settingsReady = false;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /** Queue a sync soon (coalesces bursts of changes). */
  schedule(ms = 800) {
    if (!this.signedIn()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow().catch(() => undefined), ms);
  }

  /** Delete a jump in the cloud once the undo window has passed. */
  deleteJump(id: string) {
    this.deletes.set(id, Date.now() + DELETE_DELAY_MS);
    this.saveDeletes();
    this.schedule(DELETE_DELAY_MS + 200);
  }

  cancelDelete(id: string) {
    if (this.deletes.delete(id)) this.saveDeletes();
  }

  async syncNow(): Promise<void> {
    const u = this.user();
    if (!u || this.access() !== 'allowed') return;
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    this.status.set('syncing');
    this.error.set(null);
    try {
      const sb = await this.sb();
      await this.pushDeletes(sb, u.id);
      await this.mergeJumps(sb);
      await this.pushClips(sb, u.id);
      await this.pullSettingsOnce(sb, u.id);
      const now = new Date().toISOString();
      this.lastSync.set(now);
      writeLocal(LAST_SYNC_KEY, now);
      this.status.set('idle');
    } catch (e) {
      console.warn('[jump-meter] sync failed', e);
      if (isNetworkError(e) || !navigator.onLine) {
        this.status.set('offline');
      } else {
        this.status.set('error');
        this.error.set((e as Error)?.message ?? 'Sync failed');
      }
    } finally {
      this.syncing = false;
      if (this.again) {
        this.again = false;
        this.schedule(300);
      }
    }
  }

  private async pushDeletes(sb: SupabaseClient, uid: string) {
    const now = Date.now();
    const due = [...this.deletes].filter(([, at]) => at <= now).map(([id]) => id);
    if (due.length) {
      await sb.storage
        .from(BUCKET)
        .remove(due.flatMap((id) => [`${uid}/${id}.mp4`, `${uid}/${id}.webm`, `${uid}/${id}.jpg`]));
      const { error } = await sb.from('jumps').delete().in('id', due);
      if (error) throw error;
      due.forEach((id) => this.deletes.delete(id));
      this.saveDeletes();
    }
    const next = Math.min(...this.deletes.values());
    if (isFinite(next)) this.schedule(Math.max(0, next - now) + 200);
  }

  private async mergeJumps(sb: SupabaseClient) {
    const remote = new Map<string, JumpRow>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('jumps').select('*').order('jumped_at').range(from, from + 999);
      if (error) throw error;
      data.forEach((r: JumpRow) => remote.set(r.id, r));
      if (data.length < 1000) break;
    }

    const toUpload: JumpRecord[] = [];
    const toRemove: string[] = [];
    const toUpsert: JumpRecord[] = [];

    for (const local of this.store.history()) {
      if (this.deletes.has(local.id)) continue;
      const row = remote.get(local.id);
      if (row && !local.synced) {
        toUpload.push(local); // edited on this phone (e.g. date corrected): local copy wins
        remote.delete(local.id);
      } else if (row) {
        toUpsert.push({ ...fromRow(row), synced: true });
        remote.delete(local.id);
      } else if (local.synced) {
        toRemove.push(local.id); // deleted on another device
      } else {
        toUpload.push(local);
      }
    }
    // Jumps saved on other devices.
    for (const row of remote.values()) if (!this.deletes.has(row.id)) toUpsert.push({ ...fromRow(row), synced: true });

    // Older local records may have non-UUID ids; give them proper ones before uploading.
    for (let i = 0; i < toUpload.length; i++) {
      const r = toUpload[i];
      if (isUuid(r.id)) continue;
      const id = uuid();
      const clip = await clipStore.get(r.id).catch(() => undefined);
      if (clip) {
        await clipStore.put({ ...clip, id });
        await clipStore.delete(r.id);
      }
      this.store.removeIds([r.id]);
      toUpload[i] = { ...r, id };
    }
    if (toUpload.length) {
      const { error } = await sb.from('jumps').upsert(toUpload.map(toRow));
      if (error) throw error;
      toUpsert.push(...toUpload.map((r) => ({ ...r, synced: true, hasClip: r.hasClip ?? false })));
    }
    this.store.removeIds(toRemove);
    toRemove.forEach((id) => clipStore.delete(id).catch(() => undefined));
    this.store.upsertMany(toUpsert);
  }

  private async pushClips(sb: SupabaseClient, uid: string) {
    const local = await clipStore.ids().catch(() => new Set<string>());
    const pending = this.store.history().filter((r) => r.synced && !r.hasClip && local.has(r.id));
    for (const r of pending) {
      const clip = await clipStore.get(r.id);
      if (!clip) continue;
      const ext = clip.mime.includes('webm') ? 'webm' : 'mp4';
      const base = sb.storage.from(BUCKET);
      const v = await base.upload(`${uid}/${r.id}.${ext}`, clip.video, { contentType: clip.mime.split(';')[0], upsert: true });
      if (v.error) throw v.error;
      const p = await base.upload(`${uid}/${r.id}.jpg`, clip.poster, { contentType: 'image/jpeg', upsert: true });
      if (p.error) throw p.error;
      const { error } = await sb.from('jumps').update({ has_clip: true, updated_at: new Date().toISOString() }).eq('id', r.id);
      if (error) throw error;
      this.store.patch(r.id, { hasClip: true });
    }
  }

  private async pullSettingsOnce(sb: SupabaseClient, uid: string) {
    if (this.settingsReady) return;
    const { data, error } = await sb
      .from('profiles')
      .select('settings, username, display_name, avatar_path')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw error;
    this.profile.update((p) => ({ ...p, username: data?.username ?? null, displayName: data?.display_name ?? null }));
    if (data?.avatar_path && !readLocal(avatarKey(uid))) {
      const { data: img } = await sb.storage.from(BUCKET).download(data.avatar_path);
      if (img) {
        const url = await blobToDataUrl(img);
        writeLocal(avatarKey(uid), url);
        this.profile.update((p) => ({ ...p, avatarUrl: url }));
      }
    }
    if (data?.settings && Object.keys(data.settings).length) {
      this.store.updateSettings(data.settings as Partial<Settings>);
    } else {
      await this.pushSettings(this.store.settings());
    }
    this.settingsReady = true;
  }

  private async pushSettings(settings: Settings) {
    const u = this.user();
    if (!u) return;
    const sb = await this.sb();
    const { error } = await sb
      .from('profiles')
      .upsert({ user_id: u.id, settings, updated_at: new Date().toISOString() });
    if (error) console.warn('[jump-meter] settings sync failed', error);
  }

  // ---------------------------------------------------------------------------
  // Clips from the cloud
  // ---------------------------------------------------------------------------

  /** Download a clip saved from another device, and keep a copy on this one. */
  async fetchClip(id: string): Promise<StoredClip | undefined> {
    const u = this.user();
    if (!u) return undefined;
    const sb = await this.sb();
    const base = sb.storage.from(BUCKET);
    let video: Blob | null = null;
    for (const ext of ['mp4', 'webm']) {
      const { data } = await base.download(`${u.id}/${id}.${ext}`);
      if (data) {
        video = data;
        break;
      }
    }
    if (!video) return undefined;
    const { data: poster } = await base.download(`${u.id}/${id}.jpg`);
    const clip: StoredClip = {
      id,
      video,
      poster: poster ?? new Blob([], { type: 'image/jpeg' }),
      mime: video.type || 'video/mp4',
      createdAt: new Date().toISOString(),
    };
    await clipStore.put(clip).catch(() => undefined);
    return clip;
  }

  /** Short-lived links to clip thumbnails stored in the cloud. */
  async posterUrls(ids: string[]): Promise<Record<string, string>> {
    const u = this.user();
    if (!u || !ids.length) return {};
    const sb = await this.sb();
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(
      ids.map((id) => `${u.id}/${id}.jpg`),
      3600,
    );
    const out: Record<string, string> = {};
    data?.forEach((d, i) => d.signedUrl && (out[ids[i]] = d.signedUrl));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  /** Remove every clip, jump and the account itself from the cloud. */
  async deleteAccount() {
    const u = this.user();
    if (!u) return;
    const sb = await this.sb();
    const base = sb.storage.from(BUCKET);
    for (;;) {
      const { data, error } = await base.list(u.id, { limit: 100 });
      if (error) throw error;
      if (!data.length) break;
      const { error: rmErr } = await base.remove(data.map((f) => `${u.id}/${f.name}`));
      if (rmErr) throw rmErr;
    }
    // Delete the data directly (allowed by the row-level security)…
    const j = await sb.from('jumps').delete().eq('user_id', u.id);
    if (j.error) throw j.error;
    const p = await sb.from('profiles').delete().eq('user_id', u.id);
    if (p.error) throw p.error;
    // …then the login itself, if the optional delete_my_account() function is installed.
    const { error } = await sb.rpc('delete_my_account');
    if (error) console.warn('[jump-meter] account record kept (delete_my_account not installed)', error.message);
    await sb.auth.signOut().catch(() => undefined);
    this.onSignedOut();
    this.deletes.clear();
    this.saveDeletes();
    // The jumps stay on this phone but are no longer linked to a cloud account.
    this.store.upsertMany(this.store.history().map((r) => ({ ...r, synced: false, hasClip: false })));
  }

  // ---------------------------------------------------------------------------
  // Admin: whitelist
  // ---------------------------------------------------------------------------

  async listAllowed(): Promise<AllowedEmail[]> {
    const sb = await this.sb();
    const { data, error } = await sb.from('allowed_emails').select('email, is_admin, note, added_at').order('added_at');
    if (error) throw new Error(friendlyDbError(error.message));
    return data as AllowedEmail[];
  }

  async addAllowed(email: string, isAdmin: boolean, note: string) {
    const sb = await this.sb();
    const { error } = await sb
      .from('allowed_emails')
      .insert({ email: normaliseEmail(email), is_admin: isAdmin, note: note.trim() || null });
    if (error) throw new Error(friendlyDbError(error.message));
  }

  async removeAllowed(email: string) {
    const sb = await this.sb();
    const { error } = await sb.from('allowed_emails').delete().eq('email', email);
    if (error) throw new Error(friendlyDbError(error.message));
  }

  async setAdmin(email: string, isAdmin: boolean) {
    const sb = await this.sb();
    const { error } = await sb.from('allowed_emails').update({ is_admin: isAdmin }).eq('email', email);
    if (error) throw new Error(friendlyDbError(error.message));
  }

  private saveDeletes() {
    writeLocal(DELETES_KEY, JSON.stringify(Object.fromEntries(this.deletes)));
  }
}

// -----------------------------------------------------------------------------

function toRow(r: JumpRecord): Omit<JumpRow, 'has_clip'> & { updated_at: string } {
  return {
    id: r.id,
    jumped_at: r.date,
    type: r.type,
    height_cm: r.heightCm,
    flight_ms: r.flightMs,
    capture_fps: r.captureFps,
    frames: r.frames,
    method: r.method,
    note: r.note ?? null,
    contact_ms: r.contactMs ?? null,
    rsi: r.rsi ?? null,
    box_cm: r.boxCm ?? null,
    time_to_takeoff_ms: r.timeToTakeoffMs ?? null,
    rsi_mod: r.rsiMod ?? null,
    updated_at: new Date().toISOString(),
  };
}

function fromRow(r: JumpRow): JumpRecord {
  const opt = (v: number | null) => (v === null ? undefined : v);
  return {
    id: r.id,
    date: new Date(r.jumped_at).toISOString(),
    type: r.type as JumpType,
    heightCm: r.height_cm,
    flightMs: r.flight_ms,
    captureFps: r.capture_fps,
    frames: r.frames,
    method: r.method as JumpRecord['method'],
    note: r.note ?? undefined,
    contactMs: opt(r.contact_ms),
    rsi: opt(r.rsi),
    boxCm: opt(r.box_cm),
    timeToTakeoffMs: opt(r.time_to_takeoff_ms),
    rsiMod: opt(r.rsi_mod),
    hasClip: r.has_clip,
  };
}

function appUrl() {
  return new URL('.', document.baseURI).href;
}

const avatarKey = (uid: string) => `jump-meter.avatar.${uid}`;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Centre-crop to a square and scale down, so profile pictures stay tiny. */
async function squareJpeg(file: File, size: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that image."))), 'image/jpeg', 0.85),
  );
}

function normaliseEmail(e: string) {
  return e.trim().toLowerCase();
}

function friendlyAuthError(msg: string): string {
  if (/EMAIL_NOT_APPROVED|Database error saving new user/i.test(msg)) {
    return "This email isn't approved yet. Ask the admin to add it, then try again.";
  }
  if (/rate limit|too many|seconds/i.test(msg)) return 'Too many codes requested. Wait a minute and try again.';
  if (/Invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/Email not confirmed/i.test(msg)) return 'Confirm your email first: sign in with an email code once.';
  if (/should be different/i.test(msg)) return 'Choose a password you haven\'t used for this account before.';
  if (/Password should be|weak/i.test(msg)) return 'That password is too weak. Use at least 8 characters with letters and numbers.';
  if (/expired|invalid/i.test(msg)) return "That code didn't work. It may have expired. Request a new one.";
  if (/fetch|network/i.test(msg)) return "Couldn't reach the server. Check your connection.";
  return msg;
}

function friendlyDbError(msg: string): string {
  if (/LAST_ADMIN/.test(msg)) return "You can't remove or demote the last admin.";
  if (/duplicate key/.test(msg)) return 'That email is already on the list.';
  if (/check constraint/.test(msg)) return "That doesn't look like a valid email address.";
  if (/row-level security/.test(msg)) return 'Only admins can change the list.';
  return msg;
}

function isNetworkError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /Failed to fetch|NetworkError|Load failed|network/i.test(m);
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(readLocal(key) ?? '') as T;
  } catch {
    return fallback;
  }
}
