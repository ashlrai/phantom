import { durationText } from '../ops/ops-lane-model.js';
import type { PlannerHealthRow, PlannerLimitedRow, PlannerPlanView } from './planner-plan-queries.js';

export type PlannerLineTone = 'ok' | 'warn' | 'bad';
export interface PlannerLine { text: string; tone: PlannerLineTone }

// "Nov 7 15:16" — reset times are rendered in fleet time (Eastern), like the
// held-lane headlines beside this line.
const limitedClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function untilText(iso: string | null): string | null {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return null;
  const parts = limitedClock.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')}`;
}

function limitedText(row: PlannerLimitedRow): string {
  if (row.status === 'usage-limit') {
    const until = untilText(row.until);
    return `${row.provider} limited${until ? ` until ${until}` : ''}`;
  }
  return `${row.provider} ${row.status}`;
}

function chosenDetail(health: PlannerHealthRow | undefined, nowMs: number): string {
  if (health?.status === 'ok') {
    const goodMs = Date.parse(health.lastGoodPassAt ?? '');
    return Number.isFinite(goodMs) ? `healthy, last ok ${durationText(nowMs - goodMs)} ago` : 'healthy';
  }
  if (health?.status === 'failing') return `failing${health.reason ? ` — ${health.reason}` : ''}`;
  if (health) return 'health unknown';
  return 'no health reading';
}

/**
 * The one-line planner answer at the top of the Dispatch pane: which login
 * the next fleet planner pass would run on, or why none can. null when the
 * route is absent (an older hub) — the pane renders nothing then.
 */
export function plannerLine(plan: PlannerPlanView | null | undefined, nowMs: number): PlannerLine | null {
  if (!plan) return null;
  if (plan.source === 'missing') return { text: `Planner candidates file missing: ${plan.path}.`, tone: 'warn' };
  if (plan.source === 'invalid') return { text: `Planner candidates file invalid: ${plan.path}.`, tone: 'warn' };
  if (plan.source === 'unavailable') return { text: 'Planner pass preview unavailable — planner health could not be read.', tone: 'warn' };
  if (plan.choice === null) {
    const why = plan.limited.length > 0 ? plan.limited.map(limitedText).join(', ') : 'no planner logins are configured';
    return { text: `No planner can run: ${why}. Fix the executor or add a candidate.`, tone: 'bad' };
  }
  const health = plan.health.find(row => row.provider === plan.choice!.provider);
  return { text: `Next planner pass: ${plan.choice.provider} (${chosenDetail(health, nowMs)}).`, tone: health?.status === 'ok' ? 'ok' : 'warn' };
}
