import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { StoreService, Goal, uuid } from '../core/store.service';
import { JUMP_TYPES, JumpRecord, JumpType, fromUnits, toUnits } from '../core/jump-math';
import { HeightPipe } from '../core/height.pipe';
import { Metric, goalProgress, groupSessions, readiness, readinessTrend } from '../core/insights';
import { PLANS, Plan, isoDate, planToIcs, schedule } from '../core/plans';
import { RSI_NORMS, Sex, bandFor, cmjNorms, rsiModNorms, NormTable } from '../core/norms';

const STATUS_TEXT = {
  fresh: { label: 'Fresh', advice: 'Above your normal range. A good day for hard or high-intensity work.' },
  normal: { label: 'Normal', advice: 'Within your normal range. Train as planned.' },
  'slightly-down': { label: 'Slightly down', advice: 'A little below normal. Fine to train, but keep an eye on it.' },
  fatigued: { label: 'Fatigued', advice: 'Clearly below normal. Consider a lighter day or extra recovery.' },
} as const;

@Component({
  selector: 'app-train',
  imports: [DatePipe, DecimalPipe, FormsModule, RouterLink, HeightPipe],
  template: `
    <h1>Train</h1>

    <!-- Readiness -->
    <section class="card" aria-labelledby="ready-h">
      <div class="card-head">
        <h2 id="ready-h">Readiness</h2>
        <select aria-label="Jump used for readiness" [ngModel]="readyType()" (ngModelChange)="store.updateSettings({ readinessType: $event })">
          @for (t of typesInUse(); track t) {
            <option [value]="t">{{ t }}</option>
          }
        </select>
      </div>
      @if (ready(); as r) {
        <div class="ready" [class]="'ready ' + r.status">
          <span class="pill">{{ statusText[r.status].label }}</span>
          <span class="num big">{{ r.diffPct > 0 ? '+' : '' }}{{ r.diffPct | number: '1.1-1' }}%</span>
          <span class="small">vs your baseline</span>
        </div>
        <p>{{ statusText[r.status].advice }}</p>
        <p class="small muted">
          Latest session {{ fmt(r.latest) }}, baseline {{ fmt(r.baseline) }} from {{ r.baselineSessions }} sessions. Changes
          smaller than {{ fmt(r.swc) }} are within normal day-to-day variation.
        </p>
        @if (trend().length > 1) {
          <div class="trend" aria-label="Readiness over recent sessions">
            @for (t of trend(); track t.start) {
              <span class="tdot" [class]="'tdot ' + t.r.status" [title]="(t.start | date: 'd MMM') + ': ' + statusText[t.r.status].label"></span>
            }
            <span class="small muted">last {{ trend().length }} sessions</span>
          </div>
        }
      } @else {
        <p class="muted">
          Do {{ readyType() }} tests on 4 different days (best of 3 jumps each time) and the app will learn your normal range
          and tell you each day whether you're fresh or fatigued.
          @if (sessionsFor(readyType()).length) {
            <strong>{{ sessionsFor(readyType()).length }} of 4 done.</strong>
          }
        </p>
      }
    </section>

    <!-- Plan -->
    <section class="card" aria-labelledby="plan-h">
      <h2 id="plan-h">Training plan</h2>
      @if (activePlan(); as ap) {
        <p class="plan-name">{{ ap.plan.name }} <span class="muted small">started {{ ap.start | date: 'd MMM' }}</span></p>
        @if (ap.next; as n) {
          <div class="next">
            <p class="when">
              {{ n.date === today ? 'Today' : (n.date | date: 'EEE d MMM') }}
              @if (n.week) {<span class="muted small"> week {{ n.week }} of {{ ap.plan.weeks }}, {{ n.phase }}</span>}
            </p>
            @if (n.retest) {
              <p class="retest">Re-test day: 3 × {{ ap.plan.retestType }}, best counts. <a routerLink="/measure">Measure</a></p>
            }
            @if (n.workout; as w) {
              <p class="wtitle">{{ w.title }}</p>
              <ul class="items">
                @for (i of w.items; track i) {
                  <li>{{ i }}</li>
                }
              </ul>
            }
          </div>
        } @else {
          <p>Plan complete. Do a final re-test and pick your next plan.</p>
        }
        <div class="progress-bar" role="progressbar" [attr.aria-valuenow]="ap.done" aria-valuemin="0" [attr.aria-valuemax]="ap.total">
          <span [style.width.%]="(100 * ap.done) / ap.total"></span>
        </div>
        <p class="small muted">{{ ap.done }} of {{ ap.total }} sessions past.</p>
        <div class="row">
          <button class="btn" type="button" (click)="downloadIcs(ap.plan)">Add sessions to my calendar</button>
          <button class="btn ghost" type="button" (click)="stopPlan()">Stop plan</button>
        </div>
      } @else {
        <p class="small">Pick a plan and the app schedules your sessions and re-tests. You can add them to your calendar with reminders.</p>
        <div class="field start">
          <label for="pstart">Start on</label>
          <input id="pstart" type="date" [ngModel]="planStart()" (ngModelChange)="planStart.set($event)" />
        </div>
        <ul class="plans">
          @for (p of plans; track p.id) {
            <li>
              <div>
                <p class="plan-name">{{ p.name }}</p>
                <p class="small">{{ p.summary }}</p>
                <p class="small muted">{{ p.weeks }} weeks, {{ p.sessionsPerWeek }}× a week, re-test: {{ p.retestType }}</p>
              </div>
              <button class="btn primary" type="button" (click)="startPlan(p)">Start</button>
            </li>
          }
        </ul>
      }
    </section>

    <!-- Goals -->
    <section class="card" aria-labelledby="goal-h">
      <h2 id="goal-h">Goals</h2>
      @for (g of goalViews(); track g.goal.id) {
        <div class="goal">
          <div class="goal-head">
            <strong>{{ g.goal.type }}: {{ g.label }}</strong>
            <button class="link" type="button" (click)="removeGoal(g.goal.id)">Remove</button>
          </div>
          @if (g.p; as p) {
            <div class="progress-bar" [class.done]="p.reached"><span [style.width.%]="p.fraction * 100"></span></div>
            <p class="small">
              @if (p.reached) {
                Reached! Your best is {{ g.fmt(p.current) }}.
              } @else {
                Best so far {{ g.fmt(p.current) }}.
                @if (p.perWeek !== null) {
                  Trend {{ p.perWeek >= 0 ? '+' : '' }}{{ g.fmt(p.perWeek) }} a week.
                }
                @if (p.projected) {
                  On this trend you'll get there around {{ p.projected | date: 'd MMM yyyy' }}.
                } @else {
                  Not heading there yet: the recent trend is flat or down.
                }
                @if (g.goal.by && p.onTrack !== null) {
                  <strong [class.ok]="p.onTrack" [class.bad]="!p.onTrack">{{ p.onTrack ? 'On track' : 'Behind' }} for {{ g.goal.by | date: 'd MMM yyyy' }}.</strong>
                }
              }
            </p>
          } @else {
            <p class="small muted">No {{ g.goal.type }} jumps yet.</p>
          }
        </div>
      }
      <form class="goal-form" (ngSubmit)="addGoal()">
        <div class="field">
          <label for="gtype">Jump</label>
          <select id="gtype" name="gtype" [(ngModel)]="gType">
            @for (t of jumpTypes; track t) {
              <option [value]="t">{{ t }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="gmetric">Measure</label>
          <select id="gmetric" name="gmetric" [(ngModel)]="gMetric">
            <option value="heightCm">Height ({{ units() }})</option>
            <option value="rsi">RSI</option>
            <option value="rsiMod">RSI-modified</option>
          </select>
        </div>
        <div class="field">
          <label for="gtarget">Target</label>
          <input id="gtarget" name="gtarget" type="number" inputmode="decimal" step="any" min="0" required [(ngModel)]="gTarget" />
        </div>
        <div class="field">
          <label for="gby">By (optional)</label>
          <input id="gby" name="gby" type="date" [(ngModel)]="gBy" />
        </div>
        <button class="btn" type="submit" [disabled]="!gTarget">Add goal</button>
      </form>
    </section>

    <!-- Records -->
    @if (records().length) {
      <section class="card" aria-labelledby="rec-h">
        <h2 id="rec-h">Personal records</h2>
        <ul class="records">
          @for (r of records(); track r.type) {
            <li>
              <span>{{ r.type }}</span>
              <span class="num v">{{ r.best.heightCm | height }}</span>
              <span class="small muted">{{ r.best.date | date: 'd MMM yyyy' }}@if (r.rsi) {, RSI {{ r.rsi | number: '1.2-2' }}}</span>
            </li>
          }
        </ul>
      </section>
    }

    <!-- Norms -->
    <section class="card" aria-labelledby="norm-h">
      <div class="card-head">
        <h2 id="norm-h">How you compare</h2>
        <select aria-label="Compare with" [ngModel]="sex()" (ngModelChange)="store.updateSettings({ sex: $event })">
          <option [ngValue]="null">Compare with…</option>
          <option value="male">Men</option>
          <option value="female">Women</option>
        </select>
      </div>
      @if (sex()) {
        @for (n of normViews(); track n.table.title) {
          <div class="norm">
            <p><strong>{{ n.table.title }}</strong>: your best {{ n.text }} is <strong>{{ n.band }}</strong>.</p>
            <div class="bands" role="img" [attr.aria-label]="n.table.title + ': ' + n.band">
              @for (b of n.table.bands; track b.label; let i = $index) {
                <span class="band" [class.here]="i === n.index">{{ b.label }}<small>{{ b.from > 0 ? 'from ' + n.fmt(b.from) : '' }}</small></span>
              }
            </div>
            <p class="small muted">
              @if (n.table.note) {{{ n.table.note }} }
              Source: <a [href]="n.table.source.url" target="_blank" rel="noopener">{{ n.table.source.name }}</a>.
            </p>
          </div>
        } @empty {
          <p class="muted small">Save a CMJ, drop jump or RSI-modified jump to see where you stand.</p>
        }
      } @else {
        <p class="small muted">Choose men or women to see your results against published reference ranges for trained athletes.</p>
      }
    </section>
  `,
  styles: `
    .card {
      margin-bottom: 18px;
      padding: 14px;
      background: var(--surface);
      border-radius: var(--r-lg);
      h2 {
        margin: 0 0 8px;
      }
      p {
        margin: 0 0 8px;
      }
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      select {
        min-height: 36px;
        border: 1.5px solid var(--line);
        border-radius: var(--r-sm);
        background: var(--paper);
        padding: 0 6px;
      }
    }
    .small {
      font-size: 0.86rem;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ready {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 6px;
      .pill {
        padding: 2px 12px;
        border-radius: 999px;
        font-weight: 700;
        color: #fff;
        background: var(--ink-soft);
      }
      .big {
        font-size: 2rem;
        font-weight: 700;
      }
      &.fresh .pill {
        background: var(--ok);
      }
      &.normal .pill {
        background: var(--blue);
      }
      &.slightly-down .pill {
        background: #b7791f;
      }
      &.fatigued .pill {
        background: var(--red);
      }
    }
    .trend {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tdot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--ink-soft);
      &.fresh {
        background: var(--ok);
      }
      &.normal {
        background: var(--blue);
      }
      &.slightly-down {
        background: #b7791f;
      }
      &.fatigued {
        background: var(--red);
      }
    }
    .plan-name {
      font-family: var(--display);
      font-weight: 700;
      font-size: 1.2rem;
      margin: 0;
    }
    .next {
      padding: 10px 12px;
      border-left: 4px solid var(--blue);
      background: var(--paper);
      border-radius: var(--r-sm);
      margin: 8px 0;
      .when {
        font-weight: 700;
      }
      .retest {
        color: var(--red);
        font-weight: 600;
      }
      .wtitle {
        font-weight: 600;
        margin-bottom: 2px;
      }
    }
    .items {
      margin: 0;
      padding-left: 1.2em;
      font-size: 0.92rem;
    }
    .progress-bar {
      height: 8px;
      border-radius: 4px;
      background: var(--line);
      overflow: hidden;
      margin: 8px 0 4px;
      span {
        display: block;
        height: 100%;
        background: var(--blue);
      }
      &.done span {
        background: var(--ok);
      }
    }
    .start {
      max-width: 14em;
      margin-bottom: 8px;
    }
    .plans {
      list-style: none;
      padding: 0;
      margin: 0;
      li {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        align-items: center;
        padding: 10px 0;
        border-top: 1px solid var(--line);
      }
    }
    .goal {
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }
    .goal-head {
      display: flex;
      justify-content: space-between;
    }
    .ok {
      color: var(--ok);
    }
    .bad {
      color: var(--red);
    }
    .goal-form {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
      gap: 8px;
      align-items: end;
      margin-top: 10px;
    }
    .link {
      border: 0;
      background: none;
      color: var(--blue);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
      font-size: 0.85rem;
    }
    .records {
      list-style: none;
      padding: 0;
      margin: 0;
      li {
        display: grid;
        grid-template-columns: 1fr auto;
        padding: 6px 0;
        border-top: 1px solid var(--line);
      }
      .v {
        font-weight: 700;
        font-size: 1.2rem;
      }
      .small {
        grid-column: 1 / -1;
      }
    }
    .norm {
      margin-bottom: 12px;
    }
    .bands {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      gap: 3px;
      margin: 4px 0;
    }
    .band {
      display: grid;
      padding: 6px 4px;
      border-radius: var(--r-sm);
      background: var(--paper);
      border: 1px solid var(--line);
      font-size: 0.75rem;
      font-weight: 600;
      text-align: center;
      small {
        font-weight: 400;
        color: var(--ink-soft);
      }
      &.here {
        background: var(--blue);
        border-color: var(--blue);
        color: var(--blue-ink);
        small {
          color: inherit;
        }
      }
    }
    @media (max-width: 620px) {
      .goal-form {
        grid-template-columns: 1fr 1fr;
      }
    }
  `,
})
export class Train {
  protected readonly store = inject(StoreService);
  protected readonly plans = PLANS;
  protected readonly jumpTypes = JUMP_TYPES;
  protected readonly statusText = STATUS_TEXT;
  protected readonly today = isoDate(new Date());
  protected readonly units = computed(() => this.store.settings().units);
  protected readonly sex = computed(() => this.store.settings().sex);

  protected readonly typesInUse = computed<JumpType[]>(() => {
    const used = new Set(this.store.history().map((r) => r.type));
    const list = JUMP_TYPES.filter((t) => used.has(t));
    return list.length ? list : ['CMJ'];
  });
  protected readonly readyType = computed(() => {
    const t = this.store.settings().readinessType;
    return this.typesInUse().includes(t) ? t : this.typesInUse()[0];
  });

  protected sessionsFor(type: JumpType, metric: Metric = 'heightCm') {
    return groupSessions(this.store.history(), type, metric, this.store.settings().sessionScore);
  }
  protected readonly ready = computed(() => readiness(this.sessionsFor(this.readyType())));
  protected readonly trend = computed(() => readinessTrend(this.sessionsFor(this.readyType())));

  protected fmt(cm: number) {
    const u = this.units();
    return `${toUnits(cm, u).toFixed(1)} ${u}`;
  }

  // ---- Plan
  protected readonly planStart = signal(isoDate(new Date()));
  protected readonly activePlan = computed(() => {
    const ap = this.store.settings().plan;
    const plan = ap && PLANS.find((p) => p.id === ap.planId);
    if (!ap || !plan) return null;
    const days = schedule(plan, ap.start);
    const next = days.find((d) => d.date >= this.today) ?? null;
    const done = days.filter((d) => d.date < this.today).length;
    return { plan, start: ap.start, next, done, total: days.length, days };
  });

  protected startPlan(p: Plan) {
    this.store.updateSettings({ plan: { planId: p.id, start: this.planStart() || this.today } });
  }

  protected stopPlan() {
    this.store.updateSettings({ plan: null });
  }

  protected downloadIcs(plan: Plan) {
    const ap = this.activePlan();
    if (!ap) return;
    const ics = planToIcs(plan, ap.days, location.href.split('#')[0]);
    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.id}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  // ---- Goals
  protected gType: JumpType = 'CMJ';
  protected gMetric: Goal['metric'] = 'heightCm';
  protected gTarget: number | null = null;
  protected gBy = '';

  protected addGoal() {
    const t = Number(this.gTarget);
    if (!(t > 0)) return;
    const target = this.gMetric === 'heightCm' ? fromUnits(t, this.units()) : t;
    const goal: Goal = {
      id: uuid(),
      type: this.gType,
      metric: this.gMetric,
      target: Math.round(target * 100) / 100,
      by: this.gBy ? new Date(this.gBy + 'T23:59:00').toISOString() : null,
      createdAt: new Date().toISOString(),
    };
    this.store.updateSettings({ goals: [...this.store.settings().goals, goal] });
    this.gTarget = null;
    this.gBy = '';
  }

  protected removeGoal(id: string) {
    this.store.updateSettings({ goals: this.store.settings().goals.filter((g) => g.id !== id) });
  }

  protected readonly goalViews = computed(() =>
    this.store.settings().goals.map((goal) => {
      const isHeight = goal.metric === 'heightCm';
      const fmt = (v: number) => (isHeight ? this.fmt(v) : v.toFixed(2));
      const name = isHeight ? '' : goal.metric === 'rsi' ? 'RSI ' : 'RSI-mod ';
      const p = goalProgress(this.sessionsFor(goal.type, goal.metric), goal.target, goal.by);
      return { goal, p, fmt, label: `${name}${fmt(goal.target)}` };
    }),
  );

  // ---- Records
  protected readonly records = computed(() =>
    JUMP_TYPES.map((type) => {
      const rs = this.store.history().filter((r) => r.type === type);
      if (!rs.length) return null;
      const best = rs.reduce((a, b) => (b.heightCm > a.heightCm ? b : a));
      const rsi = Math.max(0, ...rs.map((r) => r.rsi ?? 0)) || null;
      return { type, best, rsi };
    }).filter((x): x is { type: JumpType; best: JumpRecord; rsi: number | null } => !!x),
  );

  // ---- Norms
  protected readonly normViews = computed(() => {
    const sex = this.sex() as Sex | null;
    if (!sex) return [];
    const all = this.store.history();
    const best = (f: (r: JumpRecord) => number | undefined, types?: JumpType[]) =>
      Math.max(0, ...all.filter((r) => !types || types.includes(r.type)).map((r) => f(r) ?? 0));
    const out: { table: NormTable; value: number; text: string; band: string; index: number; fmt: (v: number) => string }[] = [];
    const add = (table: NormTable, value: number, fmt: (v: number) => string) => {
      if (!(value > 0)) return;
      const b = bandFor(table, value);
      out.push({ table, value, text: fmt(value), band: b.band.label.toLowerCase(), index: b.index, fmt });
    };
    add(cmjNorms(sex), best((r) => r.heightCm, ['CMJ']), (v) => this.fmt(v));
    add(RSI_NORMS, best((r) => r.rsi), (v) => v.toFixed(2));
    add(rsiModNorms(sex), best((r) => r.rsiMod), (v) => v.toFixed(2));
    return out;
  });
}
