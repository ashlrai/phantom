/** RQ-PHX-RECHECKORDERSLIVE367 — the recheck "Orders 24h:" line uses the same
 * live-worker and lane-hold evidence as `fleet order-state`. All readers are
 * faked; ids and lanes are plainly fake. */
import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatOrdersLine, summarizeOrders } from '../src/core/fleet/recheck-orders-line.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T18:05:00.000Z');
const ISO = NOW.toISOString();
const NOW_LIVE_REASON = 'orders: live workers unavailable, RUNNING not checked';
const LANES_REASON = 'orders: lane holds unavailable, BLOCKED not checked';

const TRACE: OrderTraceV1 = {
  v: 1,
  generatedAt: ISO,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [
    { at: '2026-11-14 10:00 ET', source: 'slack', key: 'k1', jobs: [{ id: 'RQ-PHX-FAKEA1', lane: 'fake-lane-a', state: 'launched', url: null }] },
    { at: '2026-11-14 09:00 ET', source: 'slack', key: 'k2', jobs: [{ id: 'RQ-PHX-FAKEB1', lane: 'fake-lane-held', state: 'queued', url: null }] },
    { at: '2026-11-14 08:00 ET', source: 'slack', key: 'k3', jobs: [{ id: 'RQ-PHX-FAKEC1', lane: 'fake-lane-c', state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/1' }] },
  ],
};
const LIVE = { v: 1, generatedAt: ISO, sourceState: 'healthy', workers: [{ pid: 1, job: 'RQ-PHX-FAKEA1', repo: 'phantom', lane: 'fake-lane-a', tier: 'x', ageSeconds: 5 }], leaders: [], orchestratorAgents: 0 };
const row = (lane: string, held: boolean) => ({ lane, target: 1, floor: 0, ceiling: 2, held, heldReason: held ? 'SECRET-REASON' : null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: held ? 'SECRET-HOLDER' : null });
const LANES: LaneTargetsV1 = { v: 1, generatedAt: ISO, sourceState: 'healthy', lanes: [row('fake-lane-a', false), row('fake-lane-held', true)] };

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => null,
    readFleetBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    readChannelHealth: () => ({ schemaVersion: 1, asOf: ISO, channels: [] }),
    listWorkBoard: () => ({ items: [], inbox: 'ok', truncated: false }) as never,
    listCoordination: () => ({ source: 'unavailable', claims: [] }) as never,
    listLiveWorkers: () => LIVE as never,
    readTailnetPeers: () => ({ asOf: ISO, self: 'fake-self', peers: [], reasons: [] }),
    readPool: () => ({ asOf: ISO, self: 'fake-self', role: 'primary', hosts: [], reasons: [] }),
    readOrders: () => TRACE,
    readLaneTargets: () => LANES,
    ...over,
  };
}
const line = (o: Awaited<ReturnType<typeof readFleetRecheck>>['orders']) => formatOrdersLine(o, s => s);

describe('recheck orders line uses live + lane evidence', () => {
  it('names VERIFIED, RUNNING and BLOCKED with healthy snapshots', async () => {
    const r = await readFleetRecheck(deps());
    expect(line(r.orders)).toMatch(/^Orders 24h: 1 VERIFIED, 1 RUNNING, 1 BLOCKED · as of /);
    expect(r.orders.reasons).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET-/);
  });

  it('falls back to trace-only counts with the two reasons when evidence is unavailable', async () => {
    const r = await readFleetRecheck(deps({
      listLiveWorkers: () => { throw new Error('boom'); },
      readLaneTargets: () => ({ ...LANES, sourceState: 'missing' }),
    }));
    expect(r.orders.counts).toEqual({ VERIFIED: 1, ASSIGNED: 1, RECEIVED: 1 });
    expect(r.orders.reasons).toEqual([NOW_LIVE_REASON, LANES_REASON]);
  });

  it('treats an unhealthy live snapshot as no evidence', async () => {
    const r = await readFleetRecheck(deps({ listLiveWorkers: () => ({ ...LIVE, sourceState: 'unavailable' }) as never }));
    expect(r.orders.counts.RUNNING).toBeUndefined();
    expect(r.orders.reasons).toEqual([NOW_LIVE_REASON]);
  });

  it('keeps "none" untouched with zero orders in the window', async () => {
    const r = await readFleetRecheck(deps({
      readOrders: () => ({ ...TRACE, orders: [] }),
      listLiveWorkers: () => { throw new Error('boom'); },
    }));
    expect(r.orders.reasons).toEqual([]);
    expect(line(r.orders)).toBe('Orders 24h: none');
  });

  it('does not change section states or overall verdict', async () => {
    const a = await readFleetRecheck(deps());
    const b = await readFleetRecheck(deps({ readLaneTargets: () => { throw new Error('x'); } }));
    expect(b.sections).toEqual(a.sections);
    expect(b.overall.state).toBe(a.overall.state);
  });

  it('is cut off by the section bound when the lane reader never resolves', async () => {
    const r = await readFleetRecheck(deps({ readLaneTargets: () => new Promise<LaneTargetsV1>(() => {}) }));
    expect(r.orders.counts).toEqual({ VERIFIED: 1, RUNNING: 1, RECEIVED: 1 });
    expect(r.orders.reasons).toEqual([LANES_REASON]);
  }, 15_000);
});

describe('summarizeOrders', () => {
  const live = { jobIds: new Set(['RQ-PHX-FAKEA1']), at: ISO };
  it('passes live and lanes through', () => {
    const o = summarizeOrders(TRACE, ISO, live, LANES);
    expect(o.counts).toEqual({ VERIFIED: 1, RUNNING: 1, BLOCKED: 1 });
    expect(o.reasons).toEqual([]);
  });
  it('adds one reason per missing argument only when orders were counted', () => {
    expect(summarizeOrders(TRACE, ISO).reasons).toEqual([NOW_LIVE_REASON, LANES_REASON]);
    expect(summarizeOrders(TRACE, ISO, live).reasons).toEqual([LANES_REASON]);
    expect(summarizeOrders({ ...TRACE, orders: [] }, ISO).reasons).toEqual([]);
  });
});
