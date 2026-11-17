import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const GEN = '2026-01-02T03:00:00.000Z';
const UNTIL = '2026-01-03T00:00:00.000Z';
const trace: OrderTraceV1 = {
  v: 1, generatedAt: GEN,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-01-01 10:00', source: 'Phantom desktop', key: 'fake-order', jobs: [
    { id: 'RQ-PHX-FAKEJOB1', lane: 'fake-lane', state: 'queued', url: null }] }],
};
const now = () => Date.parse('2026-01-02T03:05:00Z');
const noLive: LiveWorkersSnapshot = { v: 1, generatedAt: GEN, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 };
const heldLanes: LaneTargetsV1 = { v: 1, generatedAt: GEN, sourceState: 'healthy', lanes: [{
  lane: 'fake-lane', target: 0, floor: 0, ceiling: 2, held: true, heldReason: 'fake-account usage reset', heldUntil: UNTIL,
  pausedFrom: 1, lastChange: null, changedBy: 'fake-operator',
}] };
const run = (args: string[], lanes: () => Promise<LaneTargetsV1>) =>
  cmdFleetOrderState(args, { read: async () => trace, now, live: async () => noLive, lanes });
const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('fleet order-state BLOCKED on a held lane', () => {
  it('--json reports BLOCKED from slots.json with the held lane as the dependency', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--json'], async () => heldLanes)).toBe(0);
    const body = JSON.parse(logged(log));
    expect(body.lanes).toBe('healthy');
    expect(body.orders[0]).toMatchObject({ state: 'BLOCKED', evidenceSource: 'slots.json', asOf: GEN, blocker: `lane fake-lane held until ${UNTIL}` });
    expect(logged(log)).not.toContain('fake-account');
    expect(logged(log)).not.toContain('fake-operator');
  });

  it('text mode names the dependency', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run([], async () => heldLanes)).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-01-01 10:00 Phantom desktop BLOCKED as-of=${GEN} source=slots.json missing=none blocked-on=lane fake-lane held until ${UNTIL}`,
    ]);
    expect(err).not.toHaveBeenCalled();
  });

  it('a lanes seam that throws leaves the order ASSIGNED and reports lanes unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--json'], async () => { throw new Error('fake read failure'); })).toBe(0);
    const body = JSON.parse(logged(log));
    expect(body.lanes).toBe('unavailable');
    expect(body.orders[0]).toMatchObject({ state: 'RECEIVED', blocker: null });
  });

  it('a degraded lane source warns once in text mode and claims no BLOCKED', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run([], async () => ({ ...heldLanes, sourceState: 'degraded' }))).toBe(0);
    expect(err.mock.calls.map((c) => c[0])).toEqual(['warning: lane holds unavailable; BLOCKED not checked']);
    expect(logged(log)).not.toContain('BLOCKED');
  });
});
