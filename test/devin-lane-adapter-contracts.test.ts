import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import { devinFleetApiBillingGate } from '../src/core/devin/api-billing.js';
import { DEVIN_ACCOUNTING_UNAVAILABLE, devinBudgetView } from '../src/core/devin/budget.js';
import { DEFAULT_DEVIN_BUDGET, type DevinBudgetV1, type DevinTaskV1 } from '../src/core/devin/types.js';

const now = new Date(2026, 9, 5, 12);
const timestamp = now.toISOString();
const budget: DevinBudgetV1 = {
  ...DEFAULT_DEVIN_BUDGET, acuBudgetTotal: 1000, maxAcuPerDay: 1000,
  maxAcuPerSession: 10, maxConcurrent: 10, fleetMaxConcurrent: 6,
  maxSessionsPerDay: 100, fleetMaxSessionsPerDay: 100, reserveAcu: 0,
};
function tasks(count: number, origin: DevinTaskV1['origin'] = 'fleet'): DevinTaskV1[] {
  return Array.from({ length: count }, (_, index) => ({
    v: 1, id: `fixture-${index}`, repo: 'ashlrai/fixture', baseBranch: 'main',
    branch: `fixture/${index}`, title: 'Contract fixture', prompt: 'Fixture', origin,
    requestedBy: origin === 'fleet' ? 'fleet' : 'mason', sessionId: `session-${index}`, sessionUrl: null,
    state: 'running', stateReason: null, failure: null,
    createdAt: timestamp, launchedAt: timestamp, updatedAt: timestamp,
    session: { status: 'running', statusDetail: null, acusConsumed: 2, prUrls: [], readAt: timestamp },
    maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null,
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network contact'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('Devin slot target 6 and configured ceiling 10', () => {
  it.each([0, 5, 6, 9, 10, 11])('gates the next launch with %i running sessions', count => {
    const view = devinBudgetView(tasks(count), budget, now, 'ready');
    expect(view).toMatchObject({ running: count, fleetRunning: count,
      reportedAcuUsed: count * 2, acuInFlight: count * 8, acuToday: count * 10 });
    expect(view.canLaunch.ok).toBe(count < 10);
    expect(view.canFleetLaunch.ok).toBe(count < 6);
    if (count >= 10) expect(view.canLaunch.reason).toContain(`${count} of 10`);
    else if (count >= 6) expect(view.canFleetLaunch.reason).toContain(`${count} of 6 fleet`);
  });

  it('counts operator sessions against the shared ceiling without consuming the fleet target', () => {
    const fleet = tasks(5);
    const operators = tasks(4, 'operator').map(task => ({ ...task, id: `operator-${task.id}` }));
    expect(devinBudgetView([...fleet, ...operators], budget, now).canFleetLaunch.ok).toBe(true);
    expect(devinBudgetView([...fleet, ...tasks(5, 'operator')], budget, now)).toMatchObject({
      running: 10, fleetRunning: 5, canLaunch: { ok: false }, canFleetLaunch: { ok: false },
    });
  });

  it('permits the tenth fleet reservation only when explicitly configured and refuses an eleventh', () => {
    const raised = { ...budget, fleetMaxConcurrent: 10 };
    expect(devinBudgetView(tasks(9), raised, now).canFleetLaunch.ok).toBe(true);
    expect(devinBudgetView(tasks(10), raised, now).canFleetLaunch.ok).toBe(false);
  });

  it.each(['missing', 'unavailable'] as const)('holds otherwise empty capacity for %s inventory', sourceState => {
    expect(devinBudgetView([], budget, now, sourceState)).toMatchObject({
      canLaunch: { ok: false, reason: DEVIN_ACCOUNTING_UNAVAILABLE },
      canFleetLaunch: { ok: false, reason: DEVIN_ACCOUNTING_UNAVAILABLE },
    });
  });
});

describe('Devin API billing policy reads', () => {
  const policy = (meteredUsdPerDay: number): Pick<EffectivePolicy, 'spend'> => ({
    spend: { maxMode: 'balanced', meteredUsdPerDay, seats: {} },
  });
  it.each([0, -1, NaN, Infinity, -Infinity])('refuses nonpositive or nonfinite allowance %s', allowance => {
    const result = devinFleetApiBillingGate(policy(allowance));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(allowance === 0 ? '$0/day' : 'unavailable');
  });
  it('holds launches when policy is unavailable', () => {
    expect(devinFleetApiBillingGate(null)).toMatchObject({ ok: false, reason: expect.stringContaining('unavailable') });
  });
  it.each([0.01, 1, 100])('reads positive allowance %s without changing the policy', allowance => {
    const input = Object.freeze({ spend: Object.freeze(policy(allowance).spend) });
    expect(devinFleetApiBillingGate(input)).toEqual({ ok: true, reason: null });
    expect(input.spend.meteredUsdPerDay).toBe(allowance);
  });
  it('does not let a local ACU budget substitute for standing spending authority', () => {
    expect(devinBudgetView([], budget, now).canFleetLaunch.ok).toBe(true);
    expect(devinFleetApiBillingGate(policy(0)).ok).toBe(false);
  });
});
