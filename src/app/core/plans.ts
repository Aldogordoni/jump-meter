/**
 * Built-in training plans. Each has a weekly structure and scheduled re-tests;
 * re-tests can be exported to the phone's calendar as an .ics file.
 *
 * The programmes follow common plyometric guidance: low-to-moderate contacts per
 * session, at least 48 h between plyometric days, and re-testing every 2–3 weeks.
 */
import type { JumpType } from './jump-math';

export interface PlanDay {
  title: string;
  items: string[];
}

export interface Plan {
  id: string;
  name: string;
  summary: string;
  weeks: number;
  sessionsPerWeek: number;
  /** Week numbers (0 = before starting) with a re-test. */
  retestWeeks: number[];
  retestType: JumpType;
  /** Days of the week (0 = Sun) that training falls on by default. */
  days: number[];
  /** Workouts by phase; `fromWeek` is 1-based. */
  phases: { fromWeek: number; label: string; workouts: PlanDay[] }[];
}

export const PLANS: Plan[] = [
  {
    id: 'plyo-foundations',
    name: 'Plyo foundations',
    summary: 'Six weeks to build jump height safely: landing skills first, then explosive jumps. Two sessions a week.',
    weeks: 6,
    sessionsPerWeek: 2,
    retestWeeks: [0, 3, 6],
    retestType: 'CMJ',
    days: [2, 5],
    phases: [
      {
        fromWeek: 1,
        label: 'Landing and posture',
        workouts: [
          {
            title: 'Session A',
            items: [
              'Warm-up: 5 min easy jog, leg swings, 2×10 bodyweight squats',
              'Snap-down to stick landing: 3×5',
              'Squat jump, stick the landing: 3×5',
              'Low box jump (step down): 3×5',
              'Split squat: 3×8 each leg',
            ],
          },
          {
            title: 'Session B',
            items: [
              'Warm-up as session A',
              'Pogo hops, stiff ankles: 3×15',
              'Countermovement jump, stick the landing: 4×4',
              'Lateral bound and stick: 3×4 each side',
              'Calf raises: 3×15',
            ],
          },
        ],
      },
      {
        fromWeek: 3,
        label: 'Power',
        workouts: [
          {
            title: 'Session A',
            items: [
              'Warm-up as before',
              'Box jump (step down): 4×4',
              'CMJ with arm swing, max effort: 4×3, full rest',
              'Single-leg box jump: 3×3 each leg',
              'Rear-foot elevated split squat: 3×6 each leg',
            ],
          },
          {
            title: 'Session B',
            items: [
              'Warm-up as before',
              'Pogo hops: 3×20',
              'Drop jump from 30 cm, short contact: 4×4',
              'Broad jump: 4×3',
              'Hip thrust: 3×8',
            ],
          },
        ],
      },
      {
        fromWeek: 5,
        label: 'Peak',
        workouts: [
          {
            title: 'Session A',
            items: ['Warm-up as before', 'Depth jump 30–40 cm: 4×3', 'Max CMJ: 5×2, full rest', 'Trap-bar jump (light): 3×4'],
          },
          {
            title: 'Session B',
            items: ['Warm-up as before', 'Approach jumps: 5×2', 'Hurdle hops: 3×5', 'Pogo hops: 2×20'],
          },
        ],
      },
    ],
  },
  {
    id: 'reactive-strength',
    name: 'Reactive strength',
    summary: 'Four weeks of fast, stiff ground contacts to raise your RSI. Two sessions a week, drop-jump re-tests.',
    weeks: 4,
    sessionsPerWeek: 2,
    retestWeeks: [0, 2, 4],
    retestType: 'Drop jump',
    days: [1, 4],
    phases: [
      {
        fromWeek: 1,
        label: 'Stiffness',
        workouts: [
          {
            title: 'Session A',
            items: ['Warm-up: skips, A-march, 2×20 pogo', 'Pogo hops, minimal knee bend: 4×15', 'Drop jump 20 cm: 4×4', 'Single-leg pogo: 3×10 each leg'],
          },
          {
            title: 'Session B',
            items: ['Warm-up as session A', 'Ankle hops over a line: 4×10', 'Hurdle hops (low): 4×5', 'Calf raises, slow down: 3×12'],
          },
        ],
      },
      {
        fromWeek: 3,
        label: 'Reactive power',
        workouts: [
          {
            title: 'Session A',
            items: ['Warm-up as before', 'Drop jump 30 cm, contact under 0.25 s: 5×3', 'Repeated jumps 10/5: 2 sets', 'Bounds: 3×6'],
          },
          {
            title: 'Session B',
            items: ['Warm-up as before', 'Hurdle hops (higher): 4×5', 'Single-leg drop jump 15 cm: 3×3 each leg', 'Pogo hops: 2×20'],
          },
        ],
      },
    ],
  },
  {
    id: 'in-season',
    name: 'In-season maintenance',
    summary: 'Keep your jump during a playing season with one short session a week and a weekly CMJ check-in.',
    weeks: 12,
    sessionsPerWeek: 1,
    retestWeeks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    retestType: 'CMJ',
    days: [2],
    phases: [
      {
        fromWeek: 1,
        label: 'Maintain',
        workouts: [
          {
            title: 'Weekly session',
            items: ['Warm-up', 'Max CMJ: 3×2, full rest (save the best as your check-in)', 'Box jump: 3×3', 'Pogo hops: 2×15'],
          },
        ],
      },
    ],
  },
];

export interface ActivePlan {
  planId: string;
  /** Monday-ish start date (ISO date). */
  start: string;
}

export interface ScheduledDay {
  date: string; // ISO date (yyyy-mm-dd)
  week: number; // 1-based
  workout: PlanDay | null;
  phase: string | null;
  retest: boolean;
}

/** The plan's calendar: training days plus re-tests (re-tests fall on the first training day of that week). */
export function schedule(plan: Plan, startIso: string): ScheduledDay[] {
  const start = new Date(startIso + 'T00:00:00');
  const out: ScheduledDay[] = [];
  // Week 0 re-test: the start date itself.
  if (plan.retestWeeks.includes(0)) out.push({ date: isoDate(start), week: 0, workout: null, phase: null, retest: true });
  for (let w = 1; w <= plan.weeks; w++) {
    const phase = [...plan.phases].reverse().find((p) => w >= p.fromWeek)!;
    let k = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + (w - 1) * 7 + d);
      if (!plan.days.includes(day.getDay())) continue;
      const workout = phase.workouts[k % phase.workouts.length];
      const retest = k === 0 && plan.retestWeeks.includes(w) && w !== 0;
      out.push({ date: isoDate(day), week: w, workout, phase: phase.label, retest });
      k++;
    }
  }
  return out;
}

export function isoDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Calendar file with every session (and re-test) of the plan, at 18:00 local time. */
export function planToIcs(plan: Plan, days: ScheduledDay[], appUrl: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jump Meter//Plans//EN', 'CALSCALE:GREGORIAN'];
  for (const d of days) {
    const ymd = d.date.replace(/-/g, '');
    const title = d.retest
      ? `Jump Meter: ${plan.retestType} re-test${d.workout ? ` + ${d.workout.title}` : ''}`
      : `Jump Meter: ${plan.name} – ${d.workout?.title ?? ''}`;
    const body = [
      d.retest ? `Re-test: 3 × ${plan.retestType}, best counts. Film in slow motion and measure in the app.` : '',
      d.phase ? `Phase: ${d.phase} (week ${d.week})` : '',
      ...(d.workout?.items ?? []).map((i) => `• ${i}`),
      appUrl,
    ]
      .filter(Boolean)
      .join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${plan.id}-${ymd}@jump-meter`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${ymd}T180000`,
      `DTEND:${ymd}T190000`,
      `SUMMARY:${esc(title)}`,
      `DESCRIPTION:${esc(body)}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT1H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(title)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
