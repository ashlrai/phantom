import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { plannerLine } from '../../routes/verse/fleet-dispatch/planner-plan-model.js';
import type { PlannerPlanView } from '../../routes/verse/fleet-dispatch/planner-plan-queries.js';
import type { AppNotification } from './types.js';

function resetCountdown(resetMs: number, nowMs: number): string {
  const minutes = Math.ceil(Math.max(0, resetMs - nowMs) / 60_000);
  if (minutes === 0) return 'reset due';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `resets in ${[hours && `${hours}h`, remainder && `${remainder}m`].filter(Boolean).join(' ')}`;
}

export function derivePlannerNotifications(plan: PlannerPlanView | null | undefined, nowMs: number): AppNotification[] {
  if (!plan || plan.source === 'unavailable') return [];

  const line = plannerLine(plan, nowMs);
  let id: string;
  let severity: AppNotification['severity'];
  let title: string;
  let detail: string;
  if (plan.source === 'missing' || plan.source === 'invalid') {
    id = 'planner-slate';
    severity = 'high';
    title = `Planner slate ${plan.source}`;
    detail = line!.text;
  } else if (plan.choice === null) {
    id = 'planner-no-runner';
    severity = 'critical';
    title = 'No login can run the planner';
    const providers = plan.limited.map(row => `${row.provider} ${row.status}`).join(', ') || 'no planner logins are configured';
    const resets = [plan.nextResetAt, ...plan.limited.map(row => row.until)]
      .map(value => Date.parse(value ?? '')).filter(Number.isFinite);
    const earliest = resets.length ? Math.min(...resets) : null;
    const countdown = earliest === null ? '' : `, ${resetCountdown(earliest, nowMs)}`;
    detail = `${providers}${countdown}.`;
  } else {
    const health = plan.health.find(row => row.provider === plan.choice!.provider);
    if (health?.status !== 'failing') return [];
    id = 'planner-failing';
    severity = 'high';
    title = `Planner passes failing on ${plan.choice.provider}`;
    detail = line!.text;
  }

  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  return [{ id, category: 'fleet', severity, title, detail, ts: plan.generatedAt,
    actionHref: paneLinkUrl('fleet-dispatch', null, false, base) ?? undefined, actionLabel: 'Open Dispatch' }];
}
