/** RQ-PHX-ORDERAPIEVIDENCEOWNER366: the orders API binds owner and pr to
 * the same orderEvidence result that produced the state — the merged
 * artifact job, the live running job, or the fallback claim — never a
 * stopped sibling's lane or url. Fake trace, fake worker snapshots and fake
 * req/res only: no process launches, no host state reads. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_ORDER_STATE_PATH as ORDERS,
  createFleetOrderStateApi,
} from '../src/core/verse/fleet-order-state-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const GENERATED = NOW.toISOString();
const LIVE_AT = '2026-11-14T09:59:00.000Z';
const STALE_AT = '2026-11-14T09:20:00.000Z'; // 40 min before NOW: past RUNNING_FRESH_MS
const PR_PUB = 'https://github.com/ashlrai/phantom/pull/3661';
const PR_VERIFIED = 'https://github.com/ashlrai/phantom/pull/3662';

const PUB = 'RQ-PHX-PUB366'; // published sibling — stopped, never live
const LIVE = 'RQ-PHX-LIVE366'; // launched sibling — the real current worker
const MERGED_BAD = 'RQ-PHX-NOART366'; // merged without a pull artifact
const MERGED_OK = 'RQ-PHX-VERIFIED366'; // merged with the verifying pull url
const QUEUED = 'RQ-PHX-QUEUED366';

const job = (id: string, state: OrderTraceJob['state'], lane: string | null = 'devin', url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const order = (jobs: OrderTraceJob[], at = '2026-11-14 04:30 ET', key = '11-14 04:30'): OrderTraceV1['orders'][number] =>
  ({ at, source: 'mason', key, jobs });
const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1, generatedAt: GENERATED,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const worker = (jobId: string, pid = 4000): LiveWorker => ({
  pid, job: jobId, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60,
});
const snapshot = (jobs: string[], generatedAt = LIVE_AT, sourceState: 'healthy' | 'unavailable' = 'healthy'): LiveWorkersSnapshot => ({
  v: 1, generatedAt, sourceState,
  workers: sourceState === 'healthy' ? jobs.map((j, i) => worker(j, 4000 + i)) : [],
  leaders: [], orchestratorAgents: 0,
});

async function call(m: ApiModule) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = { url: ORDERS } as IncomingMessage;
  const handled = await m({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, ORDERS, 'GET');
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('order evidence owner binding', () => {
  it('a live launched sibling owns RUNNING; the stopped published sibling names nothing', async () => {
    const jobs = [job(PUB, 'published', 'claude', PR_PUB), job(LIVE, 'launched', 'devin')];
    for (const ordered of [jobs, [...jobs].reverse()]) {
      const live = vi.fn(async () => snapshot([LIVE]));
      const m = createFleetOrderStateApi({ read: async () => trace([order(ordered)]), now: () => NOW, live });
      const r = await call(m);
      expect(r.status).toBe(200);
      expect(r.handled).toBe(true);
      expect(live).toHaveBeenCalledTimes(1);
      expect(r.body.live).toBe('healthy');
      expect(r.body.orders[0]).toMatchObject({
        state: 'RUNNING',
        asOf: LIVE_AT,
        evidenceSource: `live-worker ${LIVE}`,
        missing: [],
        pr: null,
        owner: { job: LIVE, lane: 'devin' },
      });
    }
  });

  it('an artifact-less merged sibling cannot hide the verifying merged job', async () => {
    const bad = job(MERGED_BAD, 'merged', 'claude', 'https://example.test/artifacts/9');
    const ok = job(MERGED_OK, 'merged', 'devin', PR_VERIFIED);
    for (const ordered of [[bad, ok], [ok, bad]]) {
      const m = createFleetOrderStateApi({
        read: async () => trace([order(ordered)]), now: () => NOW,
        live: async () => snapshot([]),
      });
      const r = await call(m);
      expect(r.status).toBe(200);
      expect(r.body.orders[0]).toMatchObject({
        state: 'VERIFIED',
        asOf: GENERATED,
        evidenceSource: 'order-trace',
        missing: [],
        pr: PR_VERIFIED,
        owner: { job: MERGED_OK, lane: 'devin' },
      });
    }
  });

  it('a stale snapshot drops RUNNING but keeps the claim bound to the live job', async () => {
    const jobs = [job(PUB, 'published', 'claude', PR_PUB), job(LIVE, 'launched', 'devin')];
    const m = createFleetOrderStateApi({
      read: async () => trace([order(jobs)]), now: () => NOW,
      live: async () => snapshot([LIVE], STALE_AT),
    });
    const r = await call(m);
    expect(r.body.orders[0]).toMatchObject({
      state: 'ASSIGNED',
      evidenceSource: `claim:${LIVE}`,
      missing: ['fresh running evidence'],
      pr: null,
      owner: { job: LIVE, lane: 'devin' },
    });
  });

  it('unavailable live data never invents RUNNING and the published claim keeps its own owner', async () => {
    const jobs = [job(PUB, 'published', 'claude', PR_PUB), job(LIVE, 'launched', 'devin')];
    for (const live of [
      async () => snapshot([], GENERATED, 'unavailable'),
      async () => { throw new Error('SECRET ps failure /Users/fakehome/bin'); },
    ]) {
      const m = createFleetOrderStateApi({ read: async () => trace([order(jobs)]), now: () => NOW, live });
      const r = await call(m);
      expect(r.status).toBe(200);
      expect(r.body.live).toBe('unavailable');
      expect(r.body.orders[0]).toMatchObject({
        state: 'ASSIGNED',
        evidenceSource: `claim:${PUB}`,
        pr: null,
        owner: { job: PUB, lane: 'claude' },
      });
      expect(r.text).not.toMatch(/SECRET|fakehome/);
    }
  });

  it('malformed owner ids and lanes degrade to null without inventing state', async () => {
    // A merged job whose id fails the RQ shape still verifies, but names no owner.
    const badId = job('RQ-PHX BAD366', 'merged', 'devin', PR_VERIFIED);
    const m1 = createFleetOrderStateApi({
      read: async () => trace([order([badId])]), now: () => NOW,
      live: async () => snapshot([]),
    });
    expect((await call(m1)).body.orders[0]).toMatchObject({ state: 'VERIFIED', pr: PR_VERIFIED, owner: null });

    // An unsafe lane nulls the lane but keeps the job.
    const badLane = job('RQ-PHX-LANE366', 'merged', 'Devin/x', PR_VERIFIED);
    const m2 = createFleetOrderStateApi({
      read: async () => trace([order([badLane])]), now: () => NOW,
      live: async () => snapshot([]),
    });
    expect((await call(m2)).body.orders[0]).toMatchObject({
      state: 'VERIFIED', pr: PR_VERIFIED, owner: { job: 'RQ-PHX-LANE366', lane: null },
    });

    // A live job with a malformed id proves RUNNING yet names no owner.
    const liveBad = job('RQ-PHX BAD366', 'launched', 'devin');
    const m3 = createFleetOrderStateApi({
      read: async () => trace([order([liveBad])]), now: () => NOW,
      live: async () => snapshot(['RQ-PHX BAD366']),
    });
    expect((await call(m3)).body.orders[0]).toMatchObject({ state: 'RUNNING', owner: null });
  });

  it('a queued line keeps its owner hint without becoming a claim; no jobs names nothing', async () => {
    const m = createFleetOrderStateApi({
      read: async () => trace([order([job(QUEUED, 'queued', 'zai')]), order([], '2026-11-14 03:00 ET', '11-14 03:00')]),
      now: () => NOW,
      live: async () => snapshot([QUEUED]), // a queued id in the live set proves nothing
    });
    const r = await call(m);
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(2);
    expect(r.body.orders[0]).toMatchObject({
      key: '11-14 04:30',
      state: 'RECEIVED',
      missing: ['durable claim receipt'],
      pr: null,
      owner: { job: QUEUED, lane: 'zai' },
    });
    expect(r.body.orders[1]).toMatchObject({ key: '11-14 03:00', state: 'RECEIVED', pr: null, owner: null });
  });
});
