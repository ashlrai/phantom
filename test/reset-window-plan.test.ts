import { describe, expect, it, vi } from 'vitest';
import { resetWindowPlan, type ResetWindowResource } from '../src/core/fleet/reset-window-plan.js';
import { cmdFleetWindowPlan } from '../src/cli/fleet-window-plan.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const now = Date.parse('2026-10-31T23:28:00Z');
const resource = (overrides: Partial<ResetWindowResource> = {}): ResetWindowResource => ({
  resource: 'fake-expiring', usedPercent: 0, resetAt: new Date(now + 6 * 3_600_000).toISOString(),
  burnPctPerHour: 0, running: 0, target: 2, expiresUnused: true, ...overrides,
});

describe('resetWindowPlan', () => {
  it('ranks fake capacity with 100 percent left and six hours to reset first as wasting', () => {
    const input = [resource({ resource: 'fake-weekly', burnPctPerHour: 2.3, resetAt: new Date(now + 160 * 3_600_000).toISOString() }), resource()];
    const before = structuredClone(input);
    const rows = resetWindowPlan(input, now);
    expect(rows[0]).toMatchObject({ resource: 'fake-expiring', verdict: 'wasting', projectedPercentLeftAtReset: 100, hoursToEmpty: null });
    expect(rows[0]!.reason).toContain('expire unused');
    expect(input).toEqual(before);
  });
  it('marks fake weekly usage at 2.3 percent per hour with 160 hours left overspending', () => {
    const [row] = resetWindowPlan([resource({ resource: 'fake-weekly', burnPctPerHour: 2.3, resetAt: new Date(now + 160 * 3_600_000).toISOString() })], now);
    expect(row).toMatchObject({ verdict: 'overspending', projectedPercentLeftAtReset: 0 });
    expect(row!.hoursToEmpty).toBeCloseTo(100 / 2.3);
  });
  it.each([null, 'invalid', '2026-11-31T23:28:00Z', '2026-11-01T23:28:00', new Date(now).toISOString()])('gives no false verdict for reset %s', resetAt => {
    expect(resetWindowPlan([resource({ resetAt })], now)[0]).toMatchObject({ verdict: 'unknown', projectedPercentLeftAtReset: null });
  });
  it('orders wasting capacity by earliest reset, preserving ties', () => {
    const rows = resetWindowPlan([
      resource({ resource: 'fake-later' }),
      resource({ resource: 'fake-sooner', resetAt: new Date(now + 3_600_000).toISOString() }),
      resource({ resource: 'fake-tied', resetAt: new Date(now + 3_600_000).toISOString() }),
    ], now);
    expect(rows.map(row => row.resource)).toEqual(['fake-sooner', 'fake-tied', 'fake-later']);
  });
  it('is on pace when exhaustion coincides exactly with reset', () => {
    expect(resetWindowPlan([resource({ usedPercent: 40, burnPctPerHour: 10 })], now)[0]!.verdict).toBe('on-pace');
  });
  it('does not label retained capacity waste', () => {
    expect(resetWindowPlan([resource({ expiresUnused: false })], now)[0]!.verdict).toBe('on-pace');
  });
  it.each([null, -1, NaN, Infinity])('keeps invalid burn %s unknown', burnPctPerHour => {
    expect(resetWindowPlan([resource({ burnPctPerHour })], now)[0]!.verdict).toBe('unknown');
  });
});

describe('fleet window-plan', () => {
  const ledger: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), asOf: new Date(now).toISOString(),
    sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, apiSpend: null, jobsMalformedRows: null,
    lanes: [{ lane: 'codex-personal', running: 1, target: 2, held: true, window: 'weekly', usedPct: 0,
      creditsRemaining: null, resetAt: new Date(now + 160 * 3_600_000).toISOString(), burnPctPerHour: 2.3,
      tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null }] };
  it('prints JSON from the existing ledger without mutating holds or slots', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = structuredClone(ledger);
    try {
      expect(await cmdFleetWindowPlan(['--json'], async () => ledger, () => now)).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ advisory: true, resources: [{ verdict: 'overspending' }] });
      expect(ledger).toEqual(before);
    } finally { log.mockRestore(); }
  });
  it('keeps stale evidence unknown', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetWindowPlan(['--json'], async () => ({ ...ledger, asOf: new Date(now - 3600_000).toISOString() }), () => now)).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0]).resources[0].verdict).toBe('unknown');
    } finally { log.mockRestore(); }
  });
  it('rejects unsupported arguments without reading evidence', async () => {
    const read = vi.fn();
    expect(await cmdFleetWindowPlan(['--apply'], read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
