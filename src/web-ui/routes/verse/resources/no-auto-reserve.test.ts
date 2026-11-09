/**
 * no-auto-reserve.test.ts — Mason's Nov 5 correction: no automatic 85%/98%/40%
 * usage reserve in UI defaults, and unknown stays unknown. A reserve is drawn
 * or worded only when Mason stored a per-seat policy; a mode default is not a
 * setting. (The server's effective policy may still carry a default reserve —
 * routing's half — so the UI never promotes it to "kept for you".)
 */
import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { accountStatus, buildCapacityRows, windowSentence } from '../usage/capacity-strip-model.js';
import { fleetWord } from './ReadinessLines.js';
import { schedulingEvidence } from './scheduling-model.js';

const NOW = Date.parse('2026-09-24T10:00:00.000Z');

function view(stored: BudgetView['seats']): BudgetView {
  const policy = stored['claude-a'] ?? { seatId: 'claude-a', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 };
  return {
    mode: 'balanced',
    seats: stored,
    updatedAt: '2026-09-24T10:00:00.000Z',
    headroom: [],
    seatInfo: [{ seatId: 'claude-a', label: 'Claude Max', engine: 'claude', free: false }],
    effective: { 'claude-a': policy },
    readingMaxAgeMs: 600_000,
    sampledAt: '2026-09-24T10:00:00.000Z',
  } as BudgetView;
}

function rowAt(usedPercent: number | null, stored: BudgetView['seats'] = {}) {
  const w = seatWindow({ id: 'seven_day', usedPercent, resetDescription: 'resets Sep 25 at 7pm (America/New_York)' });
  const seat = nativeSeat(capacity({
    planType: 'max', windows: [w], binding: w, observedAt: '2026-09-24T09:59:00.000Z',
    usability: usedPercent === null ? 'unknown' : usedPercent >= 90 ? 'tight' : 'ready',
  }), { id: 'claude-a', accountId: 'claude-a' });
  return buildCapacityRows([seat], { now: NOW, budget: view(stored) })[0]!;
}

describe('no automatic usage reserve in the desktop capacity views', () => {
  it.each([90, 99])('a seat at %i%% used with a known allowance is available, not reserved or held', (used) => {
    const row = rowAt(used);
    const binding = row.windows.find((w) => w.binding)!;
    expect(binding.usedPercent).toBe(used);
    expect(row.reserve?.percent).toBe(0);
    expect(row.reserve?.label).not.toMatch(/reserved for you|kept for you/i);
    expect(windowSentence(row, binding, row.reserve?.percent ?? null)).toBe(`Claude Max ${binding.label}: ${used}% used${binding.resetText === null ? '' : `, ${binding.resetText}`}`);
    const status = accountStatus(row, { healthRead: true, now: NOW });
    expect(status.kind).not.toBe('spent');
    expect(status.kind).not.toBe('unavailable');
    expect(`${status.label} ${status.detail ?? ''}`).not.toMatch(/held|reserve/i);
  });

  it('an unknown reading renders as unknown, not 0% or 100%', () => {
    const row = rowAt(null);
    const binding = row.windows[0]!;
    expect(binding.usedPercent).toBeNull();
    expect(windowSentence(row, binding, row.reserve?.percent ?? null)).toMatch(/no reading/);
    expect(windowSentence(row, binding, null)).not.toMatch(/0%|100%/);
    expect(row.summary).not.toMatch(/\b(0|100)%/);
  });

  it('keeps a reserve Mason stored explicitly', () => {
    const row = rowAt(50, { 'claude-a': { seatId: 'claude-a', enabled: true, reservePercent: 25 } });
    expect(row.reserve?.percent).toBe(25);
    expect(row.reserve?.label).toBe('Reserved for you 25%');
  });

  it('does not word the router reserve as held or kept in readiness or scheduling text', () => {
    const fleet = { ready: true, word: 'Ready', tone: 'ok', detail: '', reservePercent: 40, roles: [] };
    expect(fleetWord({ fleet } as never)).toBe('Ready');
    const at = new Date(NOW - 60_000).toISOString();
    const account = (admission: string) => ({ seatId: 'claude-a', observedAt: at, admission, headroomPercent: 24, reset: null, opportunity: null, forecast: null });
    const scheduling = (admission: string) => ({ readingMaxAgeMs: 900_000, scheduling: { sourceState: 'ready', observedAt: new Date(NOW).toISOString(), accounts: [account(admission)] } });
    const seat = { seatId: 'claude-a', engine: 'claude' };
    expect(schedulingEvidence(scheduling('eligible'), seat, NOW).availability).toBe('24% available to the fleet.');
    expect(schedulingEvidence(scheduling('held'), seat, NOW).availability).not.toMatch(/reserve/i);
  });
});
