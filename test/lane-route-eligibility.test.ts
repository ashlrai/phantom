import { describe, expect, it } from 'vitest';
import type { ThroughputWindow } from '../src/core/daemon/count-preferences.js';
import { effectiveLaneTarget, laneHoldActive, routeToEligibleLane } from '../src/core/fleet/lane-route-eligibility.js';
import { computeLaneYield } from '../src/core/fleet/lane-yield-weight.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-16T15:41:00.000Z');
const row = (lane: string, over: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane, target: 2, floor: 0, ceiling: 8, held: false, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null, ...over,
});
const snap = (lanes: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 =>
  ({ v: 1, generatedAt: NOW.toISOString(), sourceState, lanes });
const flat = (lane: string): ThroughputWindow => ({ lane, status: 'fresh', headroom: 3, paid: false });

describe('routeToEligibleLane', () => {
  it('routes to an eligible lane and leaves its inputs untouched', () => {
    const targets = Object.freeze(snap([row('claude'), row('devin', { held: true, heldReason: 'credits' })]));
    const before = JSON.stringify(targets);
    const out = routeToEligibleLane({ targets, now: NOW });
    expect(out.lane).toBe('claude');
    expect(out.skipped).toEqual([expect.objectContaining({ lane: 'devin', kind: 'held' })]);
    expect(JSON.stringify(targets)).toBe(before);
  });

  it('never dispatches to an actively held lane, even one with the most room', () => {
    const targets = snap([row('codex-cmp', { target: 8, held: true, heldUntil: '2026-11-16T18:00:00Z' }), row('claude', { target: 1 })]);
    expect(routeToEligibleLane({ targets, now: NOW }).lane).toBe('claude');
    const heldNoEnd = snap([row('devin', { held: true })]);
    expect(routeToEligibleLane({ targets: heldNoEnd, now: NOW })).toMatchObject({ lane: null, skipped: [{ kind: 'held' }] });
    expect(laneHoldActive(row('x', { held: true, heldUntil: 'garbage' }), NOW)).toBe(true);
  });

  it('treats an expired hold as stale, not as a block', () => {
    const targets = snap([row('claude', { held: true, heldUntil: '2026-11-16T15:00:00Z' })]);
    expect(routeToEligibleLane({ targets, now: NOW }).lane).toBe('claude');
  });

  it('keeps Grok and Cursor out unless a fresh flat-rate reading proves no paid spend', () => {
    const targets = snap([row('grok', { target: 5 }), row('cursor', { target: 5 }), row('claude', { target: 1 })]);
    const cases: Array<ThroughputWindow[]> = [
      [],
      [{ lane: 'grok', status: 'fresh', headroom: 5 }],
      [{ lane: 'grok', status: 'fresh', headroom: 5, paid: true }],
      [{ lane: 'grok', status: 'unknown', headroom: null, paid: false }],
    ];
    for (const windows of cases) {
      const out = routeToEligibleLane({ targets, windows, now: NOW });
      expect(out.lane).toBe('claude');
      expect(out.skipped.filter((s) => s.kind === 'paid-unproven').map((s) => s.lane).sort()).toEqual(['cursor', 'grok']);
    }
    expect(routeToEligibleLane({ targets, windows: [flat('cursor')], now: NOW }).lane).toBe('cursor');
  });

  it('clamps a stale target to the lane bounds before counting room', () => {
    expect(effectiveLaneTarget(row('a', { target: 40, ceiling: 3 }))).toBe(3);
    expect(effectiveLaneTarget(row('a', { target: 0, floor: 1 }))).toBe(1);
    const targets = snap([row('claude', { target: 40, ceiling: 3 })]);
    expect(routeToEligibleLane({ targets, live: { claude: 3 }, now: NOW })).toMatchObject({ lane: null, skipped: [{ kind: 'full' }] });
    expect(routeToEligibleLane({ targets, live: { claude: 2 }, now: NOW }).lane).toBe('claude');
  });

  it('fails closed on a missing or degraded snapshot', () => {
    for (const state of ['missing', 'degraded'] as const) {
      expect(routeToEligibleLane({ targets: snap([row('claude')], state), now: NOW })).toMatchObject({ lane: null, skipped: [{ kind: 'snapshot' }] });
    }
  });

  it('skips zero-target, full and excluded lanes and picks the most room, then preference', () => {
    const targets = snap([row('a', { target: 0 }), row('b', { target: 2 }), row('c', { target: 4 }), row('d', { target: 4 })]);
    const out = routeToEligibleLane({ targets, live: { d: 1 }, exclude: ['b'], prefer: ['d'], now: NOW });
    expect(out.lane).toBe('c');
    expect(out.skipped.map((s) => [s.lane, s.kind])).toEqual([['a', 'no-target'], ['b', 'excluded']]);
    expect(routeToEligibleLane({ targets, prefer: ['d'], now: NOW }).lane).toBe('d');
  });
});

describe('lane yield weight', () => {
  const ledger = (lane: string, size: string, jobs: number, merged: number): string[] =>
    Array.from({ length: jobs }, (_, i) => {
      const job = `${lane}-${size}-${i}`;
      const rows = [{ event: 'launch', job, lane, size, ts: new Date(NOW.getTime() - i * 1000).toISOString() }];
      if (i < merged) rows.push({ event: 'outcome', job, state: 'MERGED' } as never);
      return rows.map(r => JSON.stringify(r)).join('\n');
    });
  const yields = (...parts: string[][]) => computeLaneYield(parts.flat().join('\n')).rows;
  const targets = snap([row('claude', { target: 2 }), row('zai', { target: 6 }), row('newbie', { target: 4 })]);

  it('a high-yield lane wins a large row over a lane with more room', () => {
    const rows = yields(ledger('claude', 'lg', 20, 14), ledger('zai', 'lg', 20, 2));
    const out = routeToEligibleLane({ targets, size: 'lg', yields: rows, now: NOW });
    expect(out.lane).toBe('claude');
    expect(out.testOnly).toBe(false);
  });

  it('a low-yield lane keeps a small row and is told to stay test-only', () => {
    const rows = yields(ledger('claude', 'sm', 20, 14), ledger('zai', 'sm', 20, 2));
    const out = routeToEligibleLane({ targets: snap([row('claude', { target: 2 }), row('zai', { target: 6 })]), size: 'sm', yields: rows, now: NOW });
    expect(out.lane).toBe('zai');
    expect(out.testOnly).toBe(true);
  });

  it('an unknown lane stays neutral: weight 1, never ranked below a known high lane by mistake', () => {
    const rows = yields(ledger('zai', 'lg', 9, 0));
    const zai = rows.find(r => r.lane === 'zai' && r.size === 'lg')!;
    expect(zai).toMatchObject({ known: false, yield: null, weight: 1 });
    const out = routeToEligibleLane({ targets: snap([row('zai', { target: 6 }), row('newbie', { target: 2 })]), size: 'lg', yields: rows, now: NOW });
    expect(out.lane).toBe('zai');
    expect(out.testOnly).toBe(false);
  });

  it('uses only the last 50 launches and credits the weight from yield / 0.5', () => {
    const old = ledger('claude', 'md', 50, 0).map(l => l.replace(/"ts":"[^"]+"/, '"ts":"2026-01-01T00:00:00.000Z"'));
    const rows = yields(old, ledger('claude', 'md', 50, 40));
    expect(rows.find(r => r.lane === 'claude' && r.size === 'md')).toMatchObject({ launches: 50, merged: 40, yield: 0.8, weight: 1.6 });
  });
});
