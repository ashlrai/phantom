/**
 * RQ-PHX-PLANNERSUPPLYFLOOR02 — the supply-floor escape on the autorun
 * decision: full lanes must not silence the planner when the readable
 * Phantom supply is already under the critical floor (default 6), or queued
 * filler takes every slot that frees. src/core/fleet/planner-autorun.test.ts
 * pins the fixed check order; this suite pins the floor's edge cases.
 */
import { describe, expect, it } from 'vitest';
import { decidePlannerAutorun, type PlannerAutorunInput } from '../src/core/fleet/planner-autorun.js';
import type { PlannerHealth } from '../src/core/fleet/planner-failover.js';

// Fixed local clock: Nov 1 2026 12:00. Fixture stamps sit relative to it.
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime();
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

const okHealth = (lastGoodPassAt: string | null): PlannerHealth =>
  ({ status: 'ok', failingSince: null, lastGoodPassAt, resetAt: null, reason: null });
const failingHealth = (reason: string): PlannerHealth =>
  ({ status: 'failing', failingSince: minutesAgo(30), lastGoodPassAt: null, resetAt: null, reason });
const fullLane = { lane: 'codex-personal', running: 3, target: 3, held: false };
const heldLane = { lane: 'devin', running: 0, target: 2, held: true };
const freeLane = { lane: 'claude', running: 1, target: 3, held: false };

const input = (over: Partial<PlannerAutorunInput> = {}): PlannerAutorunInput => ({
  phxReady: 5,
  lanes: [fullLane],
  health: okHealth(minutesAgo(60)),
  orchOff: false,
  nowMs: NOW,
  ...over,
});

describe('decidePlannerAutorun — supply floor with full lanes', () => {
  it('runs as supply-floor when the readable queue is under the floor', () => {
    const d = decidePlannerAutorun(input({ phxReady: 5 }));
    expect(d).toMatchObject({ run: true, reason: 'supply-floor', phxReady: 5, freeSlots: 0 });
    expect(d.detail).not.toMatch(/\//);
  });

  it('phxReady at the floor stays no-free-slots', () => {
    expect(decidePlannerAutorun(input({ phxReady: 6 })))
      .toMatchObject({ run: false, reason: 'no-free-slots', freeSlots: 0 });
  });

  it('a pass 10 minutes old is still too soon under the floor', () => {
    expect(decidePlannerAutorun(input({ phxReady: 5, health: okHealth(minutesAgo(10)) })))
      .toMatchObject({ run: false, reason: 'too-soon', minutesSinceLastPass: 10 });
  });

  it('an unreadable queue never uses the floor — no real count and no slot is a guess', () => {
    expect(decidePlannerAutorun(input({ phxReady: 0, queueUnreadable: true })))
      .toMatchObject({ run: false, reason: 'no-free-slots' });
    expect(decidePlannerAutorun(input({ phxReady: Number.NaN })))
      .toMatchObject({ run: false, reason: 'no-free-slots' });
  });

  it('orch-off and planner-failing still win over the floor', () => {
    expect(decidePlannerAutorun(input({ phxReady: 2, orchOff: true })).reason).toBe('orch-off');
    expect(decidePlannerAutorun(input({ phxReady: 2, health: failingHealth('usage-limit') })).reason)
      .toBe('planner-failing');
  });

  it('free slots keep the run reason on low-supply', () => {
    expect(decidePlannerAutorun(input({ phxReady: 5, lanes: [freeLane] })))
      .toMatchObject({ run: true, reason: 'low-supply', freeSlots: 2 });
  });

  it('a custom supplyFloor is honored', () => {
    expect(decidePlannerAutorun(input({ phxReady: 5, supplyFloor: 3 })).reason).toBe('no-free-slots');
    expect(decidePlannerAutorun(input({ phxReady: 5, supplyFloor: 8 })).reason).toBe('supply-floor');
  });

  it('all lanes held counts as no free slots, and the floor applies the same way', () => {
    expect(decidePlannerAutorun(input({ phxReady: 5, lanes: [heldLane] })))
      .toMatchObject({ run: true, reason: 'supply-floor', freeSlots: 0 });
    expect(decidePlannerAutorun(input({ phxReady: 6, lanes: [heldLane] })).reason).toBe('no-free-slots');
  });

  it('enough-supply keeps its behavior when lowSupply is set under the floor', () => {
    expect(decidePlannerAutorun(input({ phxReady: 5, lowSupply: 2 })))
      .toMatchObject({ run: false, reason: 'enough-supply' });
  });
});
