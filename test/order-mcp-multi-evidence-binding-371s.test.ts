/**
 * RQ-PHX-ORDERMCPMULTIBIND371S — fleet_order_state binds owner and pr to the
 * same evidence that proves the state: orderEvidence picks the job that
 * actually carries the proof (a live launched/published sibling, or the
 * merged sibling with a valid github pull artifact) and classifyWorkItem
 * turns that evidence into the state. A stopped higher-ranked sibling can
 * no longer lend its owner or url to a live sibling's RUNNING, and only a
 * verified merged artifact can appear as `pr`. Hermetic: injected trace,
 * live and lanes readers only — never reads ~/.ashlr-runs or the process
 * table. Tests the actual readFleetOrderState output, not a copied
 * classifier.
 */
import { describe, expect, it } from 'vitest';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR = 'https://github.com/ashlrai/phantom/pull/4242';
const UNVERIFIED = 'https://example.com/not-a-github-pull';

const job = (id: string, state: OrderTraceJob['state'], lane: string | null, url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' },
  orders,
});

const order = (key: string, jobs: OrderTraceJob[]): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key, jobs });

const liveSnap = (jobIds: string[]): LiveWorkersSnapshot => ({
  v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy',
  workers: jobIds.map((j, i) => ({ pid: 9000 + i, job: j, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 30 })),
  leaders: [], orchestratorAgents: 0,
});

const lanesMissing: LaneTargetsV1 = { v: 1, generatedAt: NOW.toISOString(), sourceState: 'missing', lanes: [] };

interface Body { orders: Array<Record<string, unknown>> }
const call = (deps: Parameters<typeof readFleetOrderState>[0] = {}): Promise<Body> =>
  readFleetOrderState({
    now: () => NOW.getTime(),
    live: async () => liveSnap([]),
    lanes: async () => lanesMissing,
    ...deps,
  }) as Promise<Body>;

describe('readFleetOrderState — multi-job evidence binding', () => {
  it('a stopped published sibling preceding a live launched sibling yields RUNNING owned by the live job with no unverified pr', async () => {
    const t = trace([order('mixed-live', [
      job('RQ-PHX-STOPD1', 'published', 'claude', UNVERIFIED),
      job('RQ-PHX-LIVE2', 'launched', 'devin'),
    ])]);
    const body = await call({ read: async () => t, live: async () => liveSnap(['RQ-PHX-LIVE2']) });
    const o = body.orders[0]!;
    expect(o.state).toBe('RUNNING');
    expect(o.evidenceSource).toBe('live-worker RQ-PHX-LIVE2');
    expect(o.owner).toEqual({ job: 'RQ-PHX-LIVE2', lane: 'devin' });
    expect(o.pr).toBeNull();
    expect(JSON.stringify(body)).not.toContain('RQ-PHX-STOPD1');
  });

  it('a merged sibling with an invalid artifact preceding a merged sibling with a valid pull url yields VERIFIED owned by the latter with exactly that artifact', async () => {
    const t = trace([order('mixed-merged', [
      job('RQ-PHX-BAD01', 'merged', 'claude', UNVERIFIED),
      job('RQ-PHX-GOOD2', 'merged', 'devin', PR),
    ])]);
    const body = await call({ read: async () => t });
    const o = body.orders[0]!;
    expect(o.state).toBe('VERIFIED');
    expect(o.pr).toBe(PR);
    expect(o.owner).toEqual({ job: 'RQ-PHX-GOOD2', lane: 'devin' });
    expect(JSON.stringify(body)).not.toContain('RQ-PHX-BAD01');
    expect(JSON.stringify(body)).not.toContain(UNVERIFIED);
  });

  it('a merged job whose url is not a github pull url never becomes verified pr evidence', async () => {
    const t = trace([order('bad-artifact', [
      job('RQ-PHX-ONLY1', 'merged', 'devin', UNVERIFIED),
    ])]);
    const body = await call({ read: async () => t });
    const o = body.orders[0]!;
    expect(o.state).not.toBe('VERIFIED');
    expect(o.pr).toBeNull();
    expect(JSON.stringify(body)).not.toContain(UNVERIFIED);
  });

  it('a queued-only order keeps its sanitized owner hint and gains no claim', async () => {
    const t = trace([order('queued-hint', [
      job('RQ-PHX-QUEU1', 'queued', 'devin'),
      job('RQ-PHX-QUEU2', 'queued', 'claude'),
    ])]);
    const body = await call({ read: async () => t, live: async () => liveSnap(['RQ-PHX-QUEU1', 'RQ-PHX-QUEU2']) });
    const o = body.orders[0]!;
    expect(o.state).toBe('RECEIVED');
    expect(o.owner).toEqual({ job: 'RQ-PHX-QUEU1', lane: 'devin' });
    expect(o.pr).toBeNull();
    expect(o.missing).toContain('durable claim receipt');
  });

  it('two calls to the same reader track live membership: ASSIGNED then RUNNING then ASSIGNED again', async () => {
    const t = trace([order('live-flap', [
      job('RQ-PHX-FLAP1', 'published', 'claude', UNVERIFIED),
      job('RQ-PHX-FLAP2', 'launched', 'devin'),
    ])]);
    let members = new Set<string>();
    const live = async (): Promise<LiveWorkersSnapshot> => liveSnap([...members]);
    const deps = { read: async () => t, live, lanes: async () => lanesMissing, now: () => NOW.getTime() };

    const first = await call(deps);
    expect(first.orders[0]).toMatchObject({
      state: 'ASSIGNED', evidenceSource: 'claim:RQ-PHX-FLAP1',
      owner: { job: 'RQ-PHX-FLAP1', lane: 'claude' }, pr: null,
    });

    members = new Set(['RQ-PHX-FLAP2']);
    const second = await call(deps);
    expect(second.orders[0]).toMatchObject({
      state: 'RUNNING', evidenceSource: 'live-worker RQ-PHX-FLAP2',
      owner: { job: 'RQ-PHX-FLAP2', lane: 'devin' }, pr: null,
    });

    members = new Set();
    const third = await call(deps);
    expect(third.orders[0]).toMatchObject({
      state: 'ASSIGNED', evidenceSource: 'claim:RQ-PHX-FLAP1',
      owner: { job: 'RQ-PHX-FLAP1', lane: 'claude' }, pr: null,
    });
  });
});
