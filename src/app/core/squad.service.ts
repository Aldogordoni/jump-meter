import { Injectable, inject, signal } from '@angular/core';
import { BUCKET, CloudService, JumpRow, fromRow } from './cloud.service';
import type { JumpRecord, JumpType } from './jump-math';
import type { StoredClip } from './clip-store';

export interface MySquad {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  createdAt: string;
  role: 'coach' | 'athlete';
  shareJumps: boolean;
  onLeaderboard: boolean;
  isOwner: boolean;
}

export interface Member {
  userId: string;
  role: 'coach' | 'athlete';
  shareJumps: boolean;
  onLeaderboard: boolean;
  joinedAt: string;
  name: string;
  username: string | null;
  avatarPath: string | null;
}

export interface LeaderRow {
  userId: string;
  name: string;
  avatarPath: string | null;
  bestHeight: number | null;
  bestRsi: number | null;
  bestDistance: number | null;
  jumps: number;
  lastJump: string;
}

export interface Comment {
  id: string;
  jumpId: string;
  authorId: string;
  author: string;
  body: string;
  createdAt: string;
  mine: boolean;
}

const nameOf = (display: string | null, username: string | null) => display || (username ? `@${username}` : 'Someone');

/**
 * Squads, coach access and comments. All access control lives in the database
 * (see supabase/migrations/0005_coaching.sql); this is a thin client.
 */
@Injectable({ providedIn: 'root' })
export class SquadService {
  private readonly cloud = inject(CloudService);
  readonly squads = signal<MySquad[]>([]);
  readonly loaded = signal(false);

  private me() {
    const u = this.cloud.user();
    if (!u) throw new Error('Sign in first.');
    return u.id;
  }

  async refresh(): Promise<MySquad[]> {
    const me = this.me();
    const sb = await this.cloud.api();
    const { data, error } = await sb
      .from('squad_members')
      .select('role, share_jumps, on_leaderboard, squads (id, name, owner_id, invite_code, created_at)')
      .eq('user_id', me);
    if (error) throw error;
    type Row = {
      role: 'coach' | 'athlete';
      share_jumps: boolean;
      on_leaderboard: boolean;
      squads: { id: string; name: string; owner_id: string; invite_code: string; created_at: string } | null;
    };
    const list = ((data ?? []) as unknown as Row[])
      .filter((r) => r.squads)
      .map((r) => ({
        id: r.squads!.id,
        name: r.squads!.name,
        ownerId: r.squads!.owner_id,
        inviteCode: r.squads!.invite_code,
        createdAt: r.squads!.created_at,
        role: r.role,
        shareJumps: r.share_jumps,
        onLeaderboard: r.on_leaderboard,
        isOwner: r.squads!.owner_id === me,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.squads.set(list);
    this.loaded.set(true);
    return list;
  }

  async create(name: string): Promise<string> {
    const sb = await this.cloud.api();
    const { data, error } = await sb.from('squads').insert({ name: name.trim().slice(0, 60) }).select('id').single();
    if (error) throw error;
    await this.refresh();
    return data.id as string;
  }

  /** Returns the squad id, or null when the code is unknown. */
  async join(code: string): Promise<string | null> {
    const sb = await this.cloud.api();
    const { data, error } = await sb.rpc('join_squad', { code: code.trim() });
    if (error) throw error;
    if (data) await this.refresh();
    return (data as string | null) ?? null;
  }

  async roster(squadId: string): Promise<Member[]> {
    const sb = await this.cloud.api();
    const { data, error } = await sb.rpc('squad_roster', { sq: squadId });
    if (error) throw error;
    // Function results come back without nullability in the generated types.
    return (data ?? []).map(
      (r) => ({
        userId: r.user_id,
        role: r.role as Member['role'],
        shareJumps: r.share_jumps,
        onLeaderboard: r.on_leaderboard,
        joinedAt: r.joined_at,
        name: nameOf(r.display_name, r.username),
        username: r.username,
        avatarPath: r.avatar_path,
      }),
    );
  }

  /** My own consent for one squad. */
  async setSharing(squadId: string, patch: { shareJumps?: boolean; onLeaderboard?: boolean }) {
    const sb = await this.cloud.api();
    const row: { share_jumps?: boolean; on_leaderboard?: boolean } = {};
    if (patch.shareJumps !== undefined) row.share_jumps = patch.shareJumps;
    if (patch.onLeaderboard !== undefined) row.on_leaderboard = patch.onLeaderboard;
    const { error } = await sb.from('squad_members').update(row).eq('squad_id', squadId).eq('user_id', this.me());
    if (error) throw error;
    this.squads.update((list) =>
      list.map((s) =>
        s.id === squadId
          ? { ...s, shareJumps: patch.shareJumps ?? s.shareJumps, onLeaderboard: patch.onLeaderboard ?? s.onLeaderboard }
          : s,
      ),
    );
  }

  async setRole(squadId: string, userId: string, role: 'coach' | 'athlete') {
    const sb = await this.cloud.api();
    const { error } = await sb.from('squad_members').update({ role }).eq('squad_id', squadId).eq('user_id', userId);
    if (error) throw error;
  }

  /** Leave (yourself) or remove someone (owner). */
  async removeMember(squadId: string, userId: string) {
    const sb = await this.cloud.api();
    const { error } = await sb.from('squad_members').delete().eq('squad_id', squadId).eq('user_id', userId);
    if (error) throw error;
    if (userId === this.me()) await this.refresh();
  }

  async deleteSquad(squadId: string) {
    const sb = await this.cloud.api();
    const { error } = await sb.from('squads').delete().eq('id', squadId);
    if (error) throw error;
    await this.refresh();
  }

  async rename(squadId: string, name: string) {
    const sb = await this.cloud.api();
    const { error } = await sb.from('squads').update({ name: name.trim().slice(0, 60) }).eq('id', squadId);
    if (error) throw error;
    await this.refresh();
  }

  async newInviteCode(squadId: string): Promise<string> {
    const sb = await this.cloud.api();
    const { data, error } = await sb.rpc('new_invite_code', { sq: squadId });
    if (error) throw error;
    await this.refresh();
    return data as string;
  }

  async leaderboard(squadId: string, type: JumpType, since: Date): Promise<LeaderRow[]> {
    const sb = await this.cloud.api();
    const { data, error } = await sb.rpc('squad_leaderboard', { sq: squadId, jump_type: type, since: since.toISOString() });
    if (error) throw error;
    return (data ?? []).map(
      (r: {
        user_id: string; display_name: string | null; username: string | null; avatar_path: string | null;
        best_height: number | null; best_rsi: number | null; best_distance: number | null; jumps: number; last_jump: string;
      }) => ({
        userId: r.user_id,
        name: nameOf(r.display_name, r.username),
        avatarPath: r.avatar_path,
        bestHeight: r.best_height,
        bestRsi: r.best_rsi,
        bestDistance: r.best_distance,
        jumps: Number(r.jumps),
        lastJump: r.last_jump,
      }),
    );
  }

  /** An athlete's jumps, for their coach (the database only returns them with consent). */
  async athleteJumps(userId: string): Promise<JumpRecord[]> {
    const sb = await this.cloud.api();
    const { data, error } = await sb
      .from('jumps')
      .select('*')
      .eq('user_id', userId)
      .order('jumped_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return (data as JumpRow[]).map(fromRow);
  }

  async athleteClip(userId: string, jumpId: string): Promise<StoredClip | undefined> {
    const sb = await this.cloud.api();
    const base = sb.storage.from(BUCKET);
    for (const ext of ['mp4', 'webm']) {
      const { data } = await base.download(`${userId}/${jumpId}.${ext}`);
      if (data) {
        return { id: jumpId, video: data, poster: new Blob([]), mime: data.type || `video/${ext}`, createdAt: '' };
      }
    }
    return undefined;
  }

  async posterUrls(userId: string, jumpIds: string[]): Promise<Record<string, string>> {
    if (!jumpIds.length) return {};
    const sb = await this.cloud.api();
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(jumpIds.map((id) => `${userId}/${id}.jpg`), 3600);
    const out: Record<string, string> = {};
    data?.forEach((d, i) => d.signedUrl && (out[jumpIds[i]] = d.signedUrl));
    return out;
  }

  /** Signed links to profile pictures, keyed by storage path. */
  async avatarUrls(paths: (string | null)[]): Promise<Record<string, string>> {
    const ps = [...new Set(paths.filter((p): p is string => !!p))];
    if (!ps.length) return {};
    const sb = await this.cloud.api();
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(ps, 3600);
    const out: Record<string, string> = {};
    data?.forEach((d, i) => d.signedUrl && (out[ps[i]] = d.signedUrl));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  async comments(jumpId: string): Promise<Comment[]> {
    const me = this.me();
    const sb = await this.cloud.api();
    const [c, a] = await Promise.all([
      sb.from('jump_comments').select('id, jump_id, author_id, body, created_at').eq('jump_id', jumpId).order('created_at'),
      sb.rpc('jump_comment_authors', { jid: jumpId }),
    ]);
    if (c.error) throw c.error;
    const names = new Map<string, string>(
      (a.data ?? []).map((r: { user_id: string; display_name: string | null; username: string | null }) => [
        r.user_id,
        nameOf(r.display_name, r.username),
      ]),
    );
    return (c.data ?? []).map((r) => ({
      id: r.id,
      jumpId: r.jump_id,
      authorId: r.author_id,
      author: r.author_id === me ? 'You' : (names.get(r.author_id) ?? 'Someone'),
      body: r.body,
      createdAt: r.created_at,
      mine: r.author_id === me,
    }));
  }

  /** Comment counts for many jumps at once. */
  async commentCounts(jumpIds: string[]): Promise<Record<string, number>> {
    if (!jumpIds.length) return {};
    const sb = await this.cloud.api();
    const { data, error } = await sb.from('jump_comments').select('jump_id').in('jump_id', jumpIds.slice(0, 300));
    if (error) return {};
    const out: Record<string, number> = {};
    for (const r of data ?? []) out[r.jump_id] = (out[r.jump_id] ?? 0) + 1;
    return out;
  }

  async addComment(jumpId: string, body: string) {
    const sb = await this.cloud.api();
    const { error } = await sb.from('jump_comments').insert({ jump_id: jumpId, body: body.trim().slice(0, 1000) });
    if (error) throw error;
  }

  async deleteComment(id: string) {
    const sb = await this.cloud.api();
    const { error } = await sb.from('jump_comments').delete().eq('id', id);
    if (error) throw error;
  }
}
