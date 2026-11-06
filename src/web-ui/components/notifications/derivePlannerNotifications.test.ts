import { describe, expect, it } from 'vitest';
import type { PlannerPlanView } from '../../routes/verse/fleet-dispatch/planner-plan-queries.js';
import { derivePlannerNotifications } from './derivePlannerNotifications.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const plan: PlannerPlanView = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', path: '/fake/planner.json', source: 'ok', choice: null,
  nextResetAt: '2026-10-31T15:00:00Z',
  limited: [{ provider: 'codex-personal', status: 'usage-limit', until: '2026-10-31T14:10:00Z' },
    { provider: 'other', status: 'offline', until: null }], health: [],
};
const choice = { provider: 'codex-personal', reason: 'available' };
const failing = { provider: choice.provider, status: 'failing', failingSince: null, lastGoodPassAt: null,
  resetAt: null, reason: 'last pass timed out' };

describe('derivePlannerNotifications', () => {
  it('reports every limited provider and the earliest reset with a stable Dispatch link', () => {
    const [item] = derivePlannerNotifications(plan, now);
    expect(item).toMatchObject({ id: 'planner-no-runner', category: 'fleet', severity: 'critical',
      title: 'No login can run the planner', detail: 'codex-personal usage-limit, other offline, resets in 2h 10m.',
      actionLabel: 'Open Dispatch', actionHref: expect.stringContaining('fleet-dispatch') });
    expect(derivePlannerNotifications(plan, now + 60_000)[0]?.id).toBe(item?.id);
    expect(derivePlannerNotifications({ ...plan, limited: [], nextResetAt: null }, now)[0]?.detail)
      .toBe('no planner logins are configured.');
    expect(derivePlannerNotifications({ ...plan, nextResetAt: 'bad', limited: [{ ...plan.limited[0]!, until: 'bad' }] }, now)[0]?.detail)
      .toBe('codex-personal usage-limit.');
    expect(derivePlannerNotifications({ ...plan, nextResetAt: null, limited: [{ ...plan.limited[0]!, until: '2026-10-31T11:00:00Z' }] }, now)[0]?.detail)
      .toContain('reset due');
  });

  it.each(['missing', 'invalid'] as const)('reports a %s slate with its path and a stable id', source => {
    const input = { ...plan, source };
    const [item] = derivePlannerNotifications(input, now);
    expect(item).toMatchObject({ id: 'planner-slate', severity: 'high', title: `Planner slate ${source}`,
      detail: `Planner candidates file ${source}: /fake/planner.json.`, actionLabel: 'Open Dispatch' });
    expect(derivePlannerNotifications(input, now + 1)[0]?.id).toBe(item?.id);
  });

  it('reports failing health only for the chosen provider', () => {
    const input = { ...plan, choice, health: [failing] };
    const [item] = derivePlannerNotifications(input, now);
    expect(item).toMatchObject({ id: 'planner-failing', severity: 'high',
      title: 'Planner passes failing on codex-personal', detail: expect.stringContaining('last pass timed out') });
    expect(derivePlannerNotifications(input, now + 1)[0]?.id).toBe(item?.id);
    expect(derivePlannerNotifications({ ...input, health: [{ ...failing, provider: 'other' }] }, now)).toEqual([]);
    expect(derivePlannerNotifications({ ...input, health: [{ ...failing, reason: null }] }, now)[0]?.detail).toContain('failing');
  });

  it('stays quiet on absent, unavailable, healthy, or unknown readings', () => {
    expect(derivePlannerNotifications(null, now)).toEqual([]);
    expect(derivePlannerNotifications(undefined, now)).toEqual([]);
    expect(derivePlannerNotifications({ ...plan, source: 'unavailable' }, now)).toEqual([]);
    expect(derivePlannerNotifications({ ...plan, choice, health: [{ ...failing, status: 'ok' }] }, now)).toEqual([]);
    expect(derivePlannerNotifications({ ...plan, choice, health: [] }, now)).toEqual([]);
  });
});
