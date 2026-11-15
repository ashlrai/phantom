import { describe, expect, it } from 'vitest';
import { decideLane, type LaneInput } from '../src/core/resources/lane-autopilot.js';

// RQ-PHX-AUTOPILOTEXHAUSTONLY391: Mason's Nov 5 2026 order removed the automatic subscription
// reserves (90% quota, 98% ACU). A lane drops to floor only at actual exhaustion; below that the
// ordinary pace/scale logic still applies. The unknown/stale-reading hold is unchanged.

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const quotaLane = (usedPercent: number | null, asOf: string | null = ago(60_000)): LaneInput => ({
  lane: 'codex-cmp', kind: 'quota-window',
  limits: { target: 10, floor: 2, ceiling: 32 },
  quota: { value: usedPercent === null ? null : { usedPercent }, asOf, ttlMs: 30 * 60_000 },
});

const devinLane = (usedAcus: number, allowanceAcus = 1000, periodFraction = 1): LaneInput => ({
  lane: 'devin', kind: 'devin',
  limits: { target: 10, floor: 3, ceiling: 16 },
  devin: { value: { usedAcus, allowanceAcus, periodFraction }, asOf: ago(60_000), ttlMs: 30 * 60_000 },
});

describe('no automatic reserve: floors only at actual exhaustion', () => {
  it('quota-window at 95% used still paces above the floor', () => {
    const d = decideLane(quotaLane(95), 'green', NOW);
    expect(d.held).toBe(false);
    expect(d.target).toBeGreaterThan(2);
    expect(d.reason).not.toContain('exhausted');
  });
  it('quota-window at 100% used drops to floor with an exhaustion reason', () => {
    const d = decideLane(quotaLane(100), 'green', NOW);
    expect(d.target).toBe(2);
    expect(d.reason).toContain('quota exhausted');
  });
  it('devin at 99% of the ACU allowance is not floored by the stop line', () => {
    const d = decideLane(devinLane(990), 'green', NOW);
    expect(d.held).toBe(false);
    expect(d.target).toBe(10);
    expect(d.reason).toBe('acu pace');
  });
  it('devin at 100% of the ACU allowance drops to floor', () => {
    const d = decideLane(devinLane(1000), 'green', NOW);
    expect(d.target).toBe(3);
    expect(d.reason).toContain('acu allowance exhausted');
  });
  it('a stale quota reading still holds the current target', () => {
    const d = decideLane(quotaLane(0, ago(31 * 60_000)), 'green', NOW);
    expect(d).toMatchObject({ target: 10, held: true });
  });
});
