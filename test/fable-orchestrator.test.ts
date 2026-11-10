import { createEngineOutputNormaliser } from '../src/core/run/engines.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clampFableShare, fableBillingReason, fableRoleEligible, planFable, type FableWeeklyReading } from '../src/core/routing/fable-orchestrator.js';
import { fableBillingStopped, observeFableBilling, observeFableBillingLine } from '../src/core/routing/fable-billing-stop.js';
import { selectArm, createSeededRng } from '../src/core/routing/bandit.js';
const now = Date.parse('2026-11-13T20:00:00Z'); // Friday 3 PM ET; reset Friday 6 PM ET.
const reading: FableWeeklyReading = { observedAtMs: now, resetAtMs: Date.parse('2026-11-13T23:00:00Z'),
  claudeWeeklyUsedPercent: 60, fableOverallWeeklyUsedPercent: 40, codingBurnPercentPerHour: 2, nextPlanPercent: 1 };
describe('Fable orchestration admission', () => {
  it.each(['leader', 'intent-triage', 'architecture', 'bottlenecks'] as const)('admits the %s planning role', role => {
    expect(planFable({ role }, reading, 100, false, now)).toMatchObject({ allowed: true, sharePercent: 50, reservePercent: 6 });
  });
  it('never turns frontier coding into orchestration', () => {
    expect(fableRoleEligible({ role: 'coding', tier: 'frontier', failures: 2, securitySensitive: true })).toBe(false);
    expect(fableRoleEligible({ role: 'review', failures: 2 })).toBe(true);
    expect(fableRoleEligible({ role: 'decomposition', securitySensitive: true })).toBe(true);
    expect(fableRoleEligible({ role: 'review', tier: 'work' })).toBe(false);
  });
  it('does not admit Fable to the ordinary bandit even when it is the only candidate', () => {
    expect(selectArm(new Map(), { tier: 'frontier', repo: 'phantom', diffClass: 'large' },
      [{ provider: 'anthropic', model: 'claude-fable-5-2', effort: 'high' }], createSeededRng(7))).toBeNull();
  });
  it.each([-1, 0, 25, 50, 51, Infinity, NaN])('hard clamps share %s', share => {
    expect(clampFableShare(share)).toBeGreaterThanOrEqual(0);
    expect(clampFableShare(share)).toBeLessThanOrEqual(50);
  });
  it('preserves coding reserve and never overshoots the allowance with the next plan', () => {
    expect(planFable({ role: 'leader' }, { ...reading, codingBurnPercentPerHour: 14 }, 50, false, now).reason).toBe('reserve');
    expect(planFable({ role: 'leader' }, { ...reading, fableOverallWeeklyUsedPercent: 49.5 }, 50, false, now).reason).toBe('allowance');
  });
  it('paces early consumption and exposes distinct usage fields without cost estimates', () => {
    expect(planFable({ role: 'leader' }, { ...reading, resetAtMs: now + 167 * 3600_000, codingBurnPercentPerHour: 0.01 }, 50, false, now).reason).toBe('pace');
    expect(planFable({ role: 'leader' }, reading, 50, false, now)).toMatchObject({ claudeWeeklyUsedPercent: 60, fableOverallWeeklyUsedPercent: 40 });
  });
  it('fails closed for missing, stale, inconsistent and unmeasured usage', () => {
    for (const input of [null, { ...reading, observedAtMs: now - 900_000 }, { ...reading, codingBurnPercentPerHour: NaN },
      { ...reading, fableOverallWeeklyUsedPercent: 70 }, { ...reading, resetAtMs: now }]) {
      expect(planFable({ role: 'leader' }, input, 50, false, now).allowed).toBe(false);
    }
    expect(planFable({ role: 'leader' }, reading, 50, true, now)).toMatchObject({ allowed: false, reason: 'billing-stop', claudeWeeklyUsedPercent: 60, fableOverallWeeklyUsedPercent: 40 });
  });
});
describe('Fable billing boundary', () => {
  it.each([
    [{ usage: { fallback_credit: 0 } }, 'fallback-credit'],
    [{ usage: { fallback_credit: false } }, 'fallback-credit'],
    [{ error: { type: 'billing_error' } }, 'billing-error'],
    [{ status: 402 }, 'http-402'],
    [{ type: 'stream_event', event: { usage: { fallback_credit: 0 } } }, 'fallback-credit'],
    [{ is_error: true, result: 'Credit balance is too low' }, 'credit-balance-low'],
    [{ error: { message: 'Credit balance is too low' } }, 'credit-balance-low'],
  ])('recognizes a real upstream billing signal', (response, reason) => expect(fableBillingReason(response)).toBe(reason));
  it.each([
    { usage: { fallback_credit: null, input_tokens: 100 } }, { costUSD: 100 }, { total_cost_usd: 100 },
    { status: 429, error: { type: 'rate_limit_error', message: 'Claude AI usage limit reached' } },
    { result: 'Credit balance is too low' },
  ])('ignores allowance, estimates and model-authored text', response => expect(fableBillingReason(response)).toBeNull());
  it('persists only a reason id and never auto-clears on a clean response', () => {
    const root = mkdtempSync(join(tmpdir(), 'fable-stop-'));
    expect(fableBillingStopped(root)).toBe(false);
    const line = JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1, fallback_credit: 'PRIVATE_VALUE' } });
    const events = createEngineOutputNormaliser({ bin: 'claude', args: [] }).line(line, Date.now());
    expect(events.some(event => event.kind === 'usage')).toBe(true);
    for (const event of events) if (event.rawLine) observeFableBillingLine(event.rawLine, root);
    expect(fableBillingStopped(root)).toBe(true);
    expect(readFileSync(join(root, 'fable-billing-stop.json'), 'utf8')).not.toContain('PRIVATE_VALUE');
    observeFableBilling({ usage: { fallback_credit: null } }, root);
    expect(fableBillingStopped(root)).toBe(true);
  });
});
