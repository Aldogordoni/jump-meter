import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CloudService } from '../core/cloud.service';
import { LeaderRow, Member, MySquad, SquadService } from '../core/squad.service';
import { StoreService } from '../core/store.service';
import { HeightPipe } from '../core/height.pipe';
import { JUMP_TYPES, JumpRecord, JumpType } from '../core/jump-math';
import { Readiness, groupSessions, readiness } from '../core/insights';
import { Avatar } from '../shared/avatar';
import { Comments } from '../shared/comments';
import { ClipViewer, ViewClip } from '../shared/clip-viewer';

interface AthleteCard {
  member: Member;
  jumps: JumpRecord[];
  last: JumpRecord | null;
  bestCmj: number | null;
  readiness: Readiness | null;
}

const PERIODS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All time', days: 365 * 30 },
];

const STATUS_LABEL = { fresh: 'Fresh', normal: 'Normal', 'slightly-down': 'Slightly down', fatigued: 'Fatigued' } as const;

@Component({
  selector: 'app-team',
  imports: [DatePipe, DecimalPipe, FormsModule, RouterLink, HeightPipe, Avatar, Comments, ClipViewer],
  template: `
    <h1>Team</h1>
    @if (!cloud.signedIn()) {
      <p class="lede">Squads let a coach follow your jumps and leave feedback, and let friends compare on a leaderboard. Sign in to use them.</p>
      <a class="btn primary" routerLink="/account">Sign in</a>
    } @else {
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <section class="squads" aria-label="Your squads">
        @if (!squads.loaded()) {
          <p class="muted">Loading your squads…</p>
        } @else if (!squads.squads().length) {
          <p class="lede">You're not in a squad yet. Join one with a code from your coach, or start your own.</p>
        } @else {
          <div class="chips" role="tablist" aria-label="Squad">
            @for (s of squads.squads(); track s.id) {
              <button role="tab" type="button" [attr.aria-selected]="s.id === current()?.id" [class.on]="s.id === current()?.id" (click)="select(s.id)">
                {{ s.name }}
              </button>
            }
          </div>
        }
        <div class="join-row">
          <form (ngSubmit)="join()" class="inline-form">
            <label for="code" class="sr-only">Invite code</label>
            <input id="code" name="code" [(ngModel)]="code" placeholder="Invite code" autocomplete="off" autocapitalize="characters" maxlength="12" />
            <button class="btn" type="submit" [disabled]="!code.trim() || busy()">Join</button>
          </form>
          <form (ngSubmit)="create()" class="inline-form">
            <label for="sname" class="sr-only">New squad name</label>
            <input id="sname" name="sname" [(ngModel)]="newName" placeholder="New squad name" maxlength="60" />
            <button class="btn" type="submit" [disabled]="!newName.trim() || busy()">Create</button>
          </form>
        </div>
      </section>

      @if (current(); as s) {
        <section class="card" aria-labelledby="share-h">
          <h2 id="share-h">What you share with {{ s.name }}</h2>
          <label class="toggle">
            <input type="checkbox" [checked]="s.shareJumps" (change)="setSharing(s, { shareJumps: $any($event.target).checked })" />
            <span>
              <strong>Let this squad's coaches see my jumps and clips</strong>
              <span class="small muted">They can watch your clips and comment. Turn it off any time and their access stops at once.</span>
            </span>
          </label>
          <label class="toggle">
            <input type="checkbox" [checked]="s.onLeaderboard" (change)="setSharing(s, { onLeaderboard: $any($event.target).checked })" />
            <span>
              <strong>Show me on the squad leaderboard</strong>
              <span class="small muted">Only your best result per jump type is shown to squad members.</span>
            </span>
          </label>
          @if (s.role === 'coach') {
            <p class="small muted">You're a coach here, so the squad's leaderboard and your athletes are below.</p>
          }
        </section>

        <section class="card" aria-labelledby="lb-h">
          <h2 id="lb-h">Leaderboard</h2>
          <div class="filters">
            <div class="field">
              <label for="lbt">Jump type</label>
              <select id="lbt" [ngModel]="lbType()" (ngModelChange)="lbType.set($event)">
                @for (t of types; track t) {
                  <option [value]="t">{{ t }}</option>
                }
              </select>
            </div>
            <div class="field">
              <label for="lbp">Period</label>
              <select id="lbp" [ngModel]="lbPeriod()" (ngModelChange)="lbPeriod.set($event)">
                @for (p of periods; track p.key) {
                  <option [value]="p.key">{{ p.label }}</option>
                }
              </select>
            </div>
          </div>
          @if (board(); as rows) {
            @if (!rows.length) {
              <p class="small muted">Nobody on the leaderboard for {{ lbType() }} in this period yet. Members appear once they opt in above.</p>
            } @else {
              <ol class="board">
                @for (r of rows; track r.userId; let i = $index) {
                  <li [class.me]="r.userId === cloud.user()?.id">
                    <span class="rank num">{{ i + 1 }}</span>
                    <app-avatar [src]="avatarUrl(r.avatarPath)" [name]="r.name" [size]="32" />
                    <span class="who">{{ r.name }}<span class="small muted"> · {{ r.jumps }} jumps, last {{ r.lastJump | date: 'd MMM' }}</span></span>
                    <strong class="num val">{{ leaderValue(r) }}</strong>
                  </li>
                }
              </ol>
            }
          } @else {
            <p class="small muted">Loading…</p>
          }
        </section>

        @if (s.role === 'coach') {
          <section class="card" aria-labelledby="ath-h">
            <h2 id="ath-h">Athletes</h2>
            @if (!athletes().length) {
              <p class="small muted">No athletes share their jumps with you yet. Send them the invite code below; they choose whether to share.</p>
            }
            <ul class="athletes">
              @for (a of athletes(); track a.member.userId) {
                <li>
                  <button type="button" class="ath" (click)="openAthlete(a)" [attr.aria-expanded]="openId() === a.member.userId">
                    <app-avatar [src]="avatarUrl(a.member.avatarPath)" [name]="a.member.name" [size]="40" />
                    <span class="ath-main">
                      <strong>{{ a.member.name }}</strong>
                      <span class="small muted">
                        @if (a.last) {
                          Last jump {{ a.last.date | date: 'd MMM' }}: {{ a.last.heightCm | height }} {{ a.last.type }}
                        } @else {
                          No jumps yet
                        }
                      </span>
                    </span>
                    @if (a.readiness; as rd) {
                      <span class="pill" [class]="'pill ' + rd.status" [attr.title]="'Readiness ' + (rd.diffPct | number: '1.1-1') + '% vs baseline'">{{ statusLabel[rd.status] }}</span>
                    }
                    @if (a.bestCmj !== null) {
                      <span class="num best">{{ a.bestCmj | height }}</span>
                    }
                  </button>
                  @if (openId() === a.member.userId) {
                    <div class="ath-detail">
                      @for (j of a.jumps.slice(0, showN()); track j.id) {
                        <div class="jrow">
                          <div class="jhead">
                            <span class="num"><strong>{{ j.heightCm | height }}</strong> {{ j.type }}</span>
                            <span class="small muted">{{ j.date | date: 'EEE d MMM, HH:mm' }}</span>
                            @if (j.rsi !== undefined) {
                              <span class="small">RSI {{ j.rsi | number: '1.2-2' }}</span>
                            }
                            @if (j.posture?.flagged) {
                              <span class="small warn-line">bent landing</span>
                            }
                            @if (j.confidence && j.confidence.level !== 'high') {
                              <span class="small muted">{{ j.confidence.level }} confidence</span>
                            }
                          </div>
                          @if (j.note) {
                            <p class="small note">{{ j.note }}</p>
                          }
                          <div class="jactions">
                            @if (j.hasClip) {
                              <button class="link" type="button" (click)="watch(a, j)" [disabled]="loadingClip() === j.id">
                                {{ loadingClip() === j.id ? 'Loading clip…' : 'Watch clip' }}
                              </button>
                            }
                            <button class="link" type="button" (click)="toggleThread(j.id)">
                              {{ thread() === j.id ? 'Hide comments' : 'Comment' }}@if (counts()[j.id]) { ({{ counts()[j.id] }})}
                            </button>
                          </div>
                          @if (thread() === j.id) {
                            <app-comments [jumpId]="j.id" (count)="setCount(j.id, $event)" />
                          }
                        </div>
                      }
                      @if (a.jumps.length > showN()) {
                        <button class="btn ghost" type="button" (click)="showN.set(showN() + 20)">Show more</button>
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          </section>
        }

        <section class="card" aria-labelledby="mem-h">
          <h2 id="mem-h">Members</h2>
          @if (s.role === 'coach') {
            <p class="invite">
              Invite code <strong class="num code">{{ s.inviteCode }}</strong>
              <button class="btn ghost" type="button" (click)="shareInvite(s)">{{ copied() ? 'Copied' : 'Share' }}</button>
              @if (s.isOwner) {
                <button class="btn ghost" type="button" (click)="rotate(s)">New code</button>
              }
            </p>
          }
          <ul class="members">
            @for (m of roster(); track m.userId) {
              <li>
                <app-avatar [src]="avatarUrl(m.avatarPath)" [name]="m.name" [size]="32" />
                <span class="who">
                  {{ m.name }}@if (m.userId === cloud.user()?.id) { (you)}
                  <span class="small muted">
                    {{ m.role === 'coach' ? 'Coach' : 'Athlete' }}{{ m.userId === s.ownerId ? ', owner' : '' }}@if (m.role === 'athlete') {, {{ m.shareJumps ? 'shares jumps' : 'not sharing' }}}
                  </span>
                </span>
                @if (s.isOwner && m.userId !== s.ownerId) {
                  <span class="mem-actions">
                    <button class="link" type="button" (click)="setRole(s, m, m.role === 'coach' ? 'athlete' : 'coach')">
                      Make {{ m.role === 'coach' ? 'athlete' : 'coach' }}
                    </button>
                    <button class="link danger" type="button" (click)="removeMember(s, m)">Remove</button>
                  </span>
                }
              </li>
            }
          </ul>
          <div class="danger-zone">
            @if (s.isOwner) {
              @if (renaming()) {
                <form (ngSubmit)="rename(s)" class="inline-form">
                  <label for="rn" class="sr-only">Squad name</label>
                  <input id="rn" name="rn" [(ngModel)]="renameTo" maxlength="60" />
                  <button class="btn" type="submit">Save</button>
                  <button class="btn ghost" type="button" (click)="renaming.set(false)">Cancel</button>
                </form>
              } @else {
                <button class="btn ghost" type="button" (click)="renameTo = s.name; renaming.set(true)">Rename</button>
              }
              <button class="btn ghost danger" type="button" (click)="deleteSquad(s)">Delete squad</button>
            } @else {
              <button class="btn ghost danger" type="button" (click)="leave(s)">Leave squad</button>
            }
          </div>
        </section>
      }

      @if (viewing(); as v) {
        <app-clip-viewer [clips]="v" [editable]="false" (closed)="closeClip()" />
      }
    }
  `,
  styles: `
    .lede {
      color: var(--ink-soft);
    }
    .error {
      color: var(--red);
    }
    .squads {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      button {
        min-height: 40px;
        padding: 0 16px;
        border-radius: 999px;
        border: 1.5px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        font-weight: 600;
        cursor: pointer;
        &.on {
          background: var(--ink);
          border-color: var(--ink);
          color: var(--paper);
        }
      }
    }
    .join-row {
      display: grid;
      gap: 8px;
    }
    .inline-form {
      display: flex;
      gap: 8px;
      input {
        flex: 1;
        min-width: 0;
      }
    }
    .card {
      background: var(--surface);
      border: 1.5px solid var(--line);
      border-radius: var(--r-lg);
      padding: 14px;
      margin-bottom: 14px;
      display: grid;
      gap: 10px;
      h2 {
        margin: 0;
        font-size: 1.3rem;
      }
    }
    .toggle {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: start;
      input {
        width: 22px;
        height: 22px;
        margin-top: 2px;
      }
      span {
        display: grid;
        gap: 2px;
      }
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .board,
    .members,
    .athletes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    .board li,
    .members li {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
    }
    .board li.me {
      background: color-mix(in srgb, var(--blue) 10%, transparent);
      border-radius: var(--r-sm);
      padding: 0 6px;
    }
    .rank {
      width: 1.6em;
      text-align: right;
      font-weight: 700;
      font-family: var(--display);
      font-size: 1.2rem;
    }
    .who {
      flex: 1;
      display: grid;
    }
    .val {
      font-family: var(--display);
      font-size: 1.3rem;
    }
    .ath {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border: 1.5px solid var(--line);
      border-radius: var(--r-sm);
      background: var(--paper);
      color: var(--ink);
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .ath-main {
      flex: 1;
      display: grid;
    }
    .best {
      font-family: var(--display);
      font-weight: 700;
      font-size: 1.2rem;
    }
    .pill {
      padding: 2px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 0.8rem;
      color: var(--on-accent);
      background: var(--ink-soft);
      &.fresh {
        background: var(--ok);
      }
      &.normal {
        background: var(--blue);
      }
      &.slightly-down {
        background: var(--warn);
      }
      &.fatigued {
        background: var(--red);
      }
    }
    .ath-detail {
      display: grid;
      gap: 8px;
      padding: 8px 4px 4px;
    }
    .jrow {
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .jhead {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      align-items: baseline;
    }
    .note {
      margin: 2px 0;
    }
    .jactions,
    .mem-actions {
      display: flex;
      gap: 14px;
    }
    .link {
      border: 0;
      background: none;
      color: var(--blue);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
      padding: 4px 0;
      &.danger {
        color: var(--red);
      }
    }
    .warn-line {
      color: var(--red);
    }
    .invite {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0;
      .code {
        font-family: var(--display);
        font-size: 1.4rem;
        letter-spacing: 0.08em;
      }
    }
    .danger-zone {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      .danger {
        color: var(--red);
        border-color: var(--red);
      }
    }
  `,
})
export class Team {
  protected readonly cloud = inject(CloudService);
  protected readonly squads = inject(SquadService);
  private readonly store = inject(StoreService);
  protected readonly types = JUMP_TYPES;
  protected readonly periods = PERIODS;
  protected readonly statusLabel = STATUS_LABEL;

  protected readonly selectedId = signal<string | null>(null);
  protected readonly current = computed<MySquad | null>(() => {
    const list = this.squads.squads();
    return list.find((s) => s.id === this.selectedId()) ?? list[0] ?? null;
  });
  protected readonly roster = signal<Member[]>([]);
  protected readonly board = signal<LeaderRow[] | null>(null);
  protected readonly athletes = signal<AthleteCard[]>([]);
  protected readonly avatars = signal<Record<string, string>>({});
  protected readonly lbType = signal<JumpType>('CMJ');
  protected readonly lbPeriod = signal('30');
  private readonly boardTick = signal(0);
  protected readonly openId = signal<string | null>(null);
  protected readonly showN = signal(20);
  protected readonly thread = signal<string | null>(null);
  protected readonly counts = signal<Record<string, number>>({});
  protected readonly viewing = signal<ViewClip[] | null>(null);
  protected readonly loadingClip = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly renaming = signal(false);
  protected code = '';
  protected newName = '';
  protected renameTo = '';

  constructor() {
    // Load squads once signed in.
    effect(() => {
      if (this.cloud.signedIn()) untracked(() => this.run(() => this.squads.refresh()));
    });
    // Squad details when the selection changes.
    effect(() => {
      const s = this.current();
      if (!s) return;
      untracked(() => this.loadSquad(s));
    });
    // Leaderboard when its filters change.
    effect(() => {
      const s = this.current();
      const type = this.lbType();
      const period = PERIODS.find((p) => p.key === this.lbPeriod())!;
      this.boardTick();
      if (!s) return;
      untracked(() => {
        this.board.set(null);
        this.run(async () => {
          const rows = await this.squads.leaderboard(s.id, type, new Date(Date.now() - period.days * 86400000));
          rows.sort((a, b) => this.sortValue(b) - this.sortValue(a));
          this.board.set(rows);
          this.loadAvatars(rows.map((r) => r.avatarPath));
        });
      });
    });
  }

  private async run(fn: () => Promise<unknown>) {
    try {
      this.error.set(null);
      await fn();
    } catch (e) {
      console.warn(e);
      this.error.set((e as Error)?.message || 'Something went wrong. Check your connection.');
    }
  }

  protected select(id: string) {
    this.selectedId.set(id);
    this.openId.set(null);
    this.thread.set(null);
    this.renaming.set(false);
  }

  private async loadSquad(s: MySquad) {
    this.roster.set([]);
    this.athletes.set([]);
    await this.run(async () => {
      const roster = await this.squads.roster(s.id);
      this.roster.set(roster);
      this.loadAvatars(roster.map((m) => m.avatarPath));
      if (s.role !== 'coach') return;
      const me = this.cloud.user()?.id;
      const sharing = roster.filter((m) => m.role === 'athlete' && m.shareJumps && m.userId !== me);
      const cards = await Promise.all(
        sharing.map(async (m) => {
          const jumps = await this.squads.athleteJumps(m.userId).catch(() => []);
          const cmj = jumps.filter((j) => j.type === 'CMJ');
          return {
            member: m,
            jumps,
            last: jumps[0] ?? null,
            bestCmj: cmj.length ? Math.max(...cmj.map((j) => j.heightCm)) : null,
            readiness: readiness(groupSessions(jumps, 'CMJ', 'heightCm', this.store.settings().sessionScore)),
          };
        }),
      );
      this.athletes.set(cards.sort((a, b) => (b.last?.date ?? '').localeCompare(a.last?.date ?? '')));
    });
  }

  private loadAvatars(paths: (string | null)[]) {
    const need = paths.filter((p): p is string => !!p && !this.avatars()[p]);
    if (!need.length) return;
    this.squads
      .avatarUrls(need)
      .then((urls) => this.avatars.update((a) => ({ ...a, ...urls })))
      .catch(() => undefined);
  }

  protected avatarUrl(path: string | null) {
    return path ? (this.avatars()[path] ?? null) : null;
  }

  private sortValue(r: LeaderRow) {
    const t = this.lbType();
    if (t === 'Drop jump' || t === 'Repeated jumps') return r.bestRsi ?? -1;
    if (t === 'Broad jump') return r.bestDistance ?? r.bestHeight ?? -1;
    return r.bestHeight ?? -1;
  }

  protected leaderValue(r: LeaderRow) {
    const t = this.lbType();
    const u = this.store.settings().units;
    const fmt = (cm: number) => `${(u === 'in' ? cm / 2.54 : cm).toFixed(1)} ${u}`;
    if ((t === 'Drop jump' || t === 'Repeated jumps') && r.bestRsi !== null) return `RSI ${r.bestRsi.toFixed(2)}`;
    if (t === 'Broad jump' && r.bestDistance !== null) return fmt(r.bestDistance);
    return r.bestHeight !== null ? fmt(r.bestHeight) : '–';
  }

  protected async join() {
    this.busy.set(true);
    await this.run(async () => {
      const id = await this.squads.join(this.code);
      if (!id) throw new Error("That code didn't match a squad. Check it with your coach.");
      this.code = '';
      this.selectedId.set(id);
    });
    this.busy.set(false);
  }

  protected async create() {
    this.busy.set(true);
    await this.run(async () => {
      const id = await this.squads.create(this.newName);
      this.newName = '';
      this.selectedId.set(id);
    });
    this.busy.set(false);
  }

  protected setSharing(s: MySquad, patch: { shareJumps?: boolean; onLeaderboard?: boolean }) {
    this.run(async () => {
      await this.squads.setSharing(s.id, patch);
      // Make sure your jumps are in the cloud before a coach looks.
      if (patch.shareJumps) this.cloud.schedule(0);
      await this.loadSquad(this.current()!);
      this.boardTick.update((n) => n + 1);
    });
  }

  protected setRole(s: MySquad, m: Member, role: 'coach' | 'athlete') {
    this.run(async () => {
      await this.squads.setRole(s.id, m.userId, role);
      await this.loadSquad(s);
    });
  }

  protected removeMember(s: MySquad, m: Member) {
    if (!confirm(`Remove ${m.name} from ${s.name}?`)) return;
    this.run(async () => {
      await this.squads.removeMember(s.id, m.userId);
      await this.loadSquad(s);
    });
  }

  protected leave(s: MySquad) {
    if (!confirm(`Leave ${s.name}? Its coaches will no longer see your jumps.`)) return;
    this.run(async () => {
      await this.squads.removeMember(s.id, this.cloud.user()!.id);
      this.selectedId.set(null);
    });
  }

  protected deleteSquad(s: MySquad) {
    if (!confirm(`Delete ${s.name} for everyone? Members keep their own jumps.`)) return;
    this.run(async () => {
      await this.squads.deleteSquad(s.id);
      this.selectedId.set(null);
    });
  }

  protected rename(s: MySquad) {
    this.run(async () => {
      await this.squads.rename(s.id, this.renameTo);
      this.renaming.set(false);
    });
  }

  protected rotate(s: MySquad) {
    if (!confirm('Make a new invite code? The old one stops working.')) return;
    this.run(() => this.squads.newInviteCode(s.id));
  }

  protected async shareInvite(s: MySquad) {
    const text = `Join my squad "${s.name}" on Jump Meter: open ${new URL('.', document.baseURI).href}#/team and enter the code ${s.inviteCode}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Join my squad', text });
      else {
        await navigator.clipboard.writeText(text);
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      }
    } catch {
      /* cancelled */
    }
  }

  protected openAthlete(a: AthleteCard) {
    const open = this.openId() === a.member.userId ? null : a.member.userId;
    this.openId.set(open);
    this.showN.set(20);
    this.thread.set(null);
    if (open) {
      this.squads
        .commentCounts(a.jumps.slice(0, 100).map((j) => j.id))
        .then((c) => this.counts.update((x) => ({ ...x, ...c })))
        .catch(() => undefined);
    }
  }

  protected toggleThread(id: string) {
    this.thread.set(this.thread() === id ? null : id);
  }

  protected setCount(id: string, n: number) {
    this.counts.update((c) => ({ ...c, [id]: n }));
  }

  protected async watch(a: AthleteCard, j: JumpRecord) {
    this.loadingClip.set(j.id);
    try {
      const clip = await this.squads.athleteClip(a.member.userId, j.id);
      if (!clip) {
        this.error.set("That clip couldn't be loaded.");
        return;
      }
      const u = this.store.settings().units;
      this.viewing.set([
        {
          id: j.id,
          url: URL.createObjectURL(clip.video),
          label: `${a.member.name}, ${(u === 'in' ? j.heightCm / 2.54 : j.heightCm).toFixed(1)} ${u} ${j.type}`,
          fileName: `${a.member.name.replace(/\W+/g, '-')}-${j.date.slice(0, 10)}.${clip.mime.includes('webm') ? 'webm' : 'mp4'}`,
          video: clip.video,
          mime: clip.mime,
        },
      ]);
    } finally {
      this.loadingClip.set(null);
    }
  }

  protected closeClip() {
    for (const v of this.viewing() ?? []) URL.revokeObjectURL(v.url);
    this.viewing.set(null);
  }
}
