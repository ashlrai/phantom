/** RQ-PHX-ORDERMULTIJOBLIVE363S: an order with several dispatched jobs must
 * report the job that is actually executing. A published (stopped) sibling
 * used to outrank a launched live sibling in mostAdvancedJob, so the order
 * read ASSIGNED while a worker was really running. orderEvidence now keeps
 * valid merged-artifact precedence, otherwise takes live evidence from any
 * eligible launched/published job — owner and claim receipt bound to that
 * same job — and falls back to mostAdvancedJob when nothing is live.
 *
 * Every read goes through the real cmdFleetOrderState with injected trace,
 * clock and live-snapshot readers only: no process is spawned, no
 * ~/.ashlr-runs is read, all values are fake. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const GENERATED = '2026-11-14T11:00:00.000Z';
const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const LIVE_AT = '2026-11-14T11:59:00.000Z';
const STALE_AT = '2026-11-14T11:20:00.000Z'; // 40 min before NOW_MS: past RUNNING_FRESH_MS
const FUTURE_AT = '2026-11-14T12:10:00.000Z'; // beyond the future skew window
const PR_URL = 'https://github.com/ashlrai/phantom/pull/363';
// '2026-11-14 06:00' ET is 2026-11-14T11:00:00.000Z (EST, UTC-5).
const ORDER_AT = '2026-11-14 06:00';
const RECEIVED_ISO = '2026-11-14T11:00:00.000Z';

const PUB = 'RQ-PHX-PUBLISHED363'; // published sibling — stopped, never live
const LIVE = 'RQ-PHX-LAUNCHED363'; // launched sibling — the real current worker
const MERGED = 'RQ-PHX-MERGED363';
const QUEUED = 'RQ-PHX-QUEUED363';
const UNRELATED = 'RQ-PHX-UNRELATED363';

const job = (id: string, state: OrderTraceJob['state'], lane: string | null = 'devin', url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (jobs: OrderTraceJob[]): OrderTraceV1 => ({
  v: 1, generatedAt: GENERATED,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: ORDER_AT, source: 'Phantom desktop', key: '11-14 06:00', jobs }],
});

const snapshot = (jobIds: string[], generatedAt = LIVE_AT): LiveWorkersSnapshot => ({
  v: 1, generatedAt, sourceState: 'healthy',
  workers: jobIds.map((j, i) => ({ pid: 9000 + i, job: j, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 120 })),
  leaders: [], orchestratorAgents: 0,
});

const run = (t: OrderTraceV1, live: () => Promise<LiveWorkersSnapshot>, nowMs = NOW_MS) =>
  cmdFleetOrderState(['--json'], { read: async () => t, now: () => nowMs, live });
const order0 = (log: ReturnType<typeof vi.spyOn>) =>
  (JSON.parse(log.mock.calls.map((c) => String(c[0])).join('\n')) as {
    live: string;
    orders: Array<{ state: string; asOf: string; evidenceSource: string; missing: string[]; pr: string | null }>;
  }).orders[0]!;

afterEach(() => vi.restoreAllMocks());

describe('order-state with multiple dispatched jobs', () => {
  it('a live launched sibling outranks a stopped published sibling, in either job order', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const jobs = [job(PUB, 'published', 'claude'), job(LIVE, 'launched', 'devin')];
    for (const ordered of [jobs, [...jobs].reverse()]) {
      log.mockClear();
      expect(await run(trace(ordered), async () => snapshot([LIVE]))).toBe(0);
      const o = order0(log);
      expect(o.state).toBe('RUNNING');
      expect(o.asOf).toBe(LIVE_AT);
      expect(o.evidenceSource).toBe(`live-worker ${LIVE}`);
      expect(o.missing).toEqual([]);
    }
  });

  it('a healthy empty snapshot removes RUNNING and the published sibling names the claim', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(PUB, 'published', 'claude'), job(LIVE, 'launched', 'devin')]);
    expect(await run(t, async () => snapshot([]))).toBe(0);
    const o = order0(log);
    expect(o.state).toBe('ASSIGNED');
    expect(o.asOf).toBe(RECEIVED_ISO);
    expect(o.evidenceSource).toBe(`claim:${PUB}`);
  });

  it('unrelated and queued live ids never prove execution', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(PUB, 'published', 'claude'), job(QUEUED, 'queued', 'zai'), job(LIVE, 'launched', 'devin')]);
    // Only an unrelated worker and the queued job id are live.
    expect(await run(t, async () => snapshot([UNRELATED, QUEUED]))).toBe(0);
    const o = order0(log);
    expect(o.state).toBe('ASSIGNED');
    expect(o.evidenceSource).toBe(`claim:${PUB}`);
    // An order whose only live id is queued stays RECEIVED — queued is not a claim.
    log.mockClear();
    const queuedOnly = trace([job(QUEUED, 'queued', 'zai')]);
    expect(await run(queuedOnly, async () => snapshot([QUEUED]))).toBe(0);
    const q = order0(log);
    expect(q.state).toBe('RECEIVED');
    expect(q.evidenceSource).toBe('receivedAt');
    expect(q.missing).toContain('durable claim receipt');
  });

  it('a valid merged pull url still verifies ahead of live siblings', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(LIVE, 'launched', 'devin'), job(PUB, 'published', 'claude'), job(MERGED, 'merged', 'devin', PR_URL)]);
    expect(await run(t, async () => snapshot([LIVE]))).toBe(0);
    const o = order0(log);
    expect(o.state).toBe('VERIFIED');
    expect(o.asOf).toBe(GENERATED);
    expect(o.evidenceSource).toBe('order-trace');
    expect(o.pr).toBe(PR_URL);
  });

  it('a merged job without a pull artifact does not block live evidence', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(MERGED, 'merged', 'devin'), job(LIVE, 'launched', 'devin')]);
    expect(await run(t, async () => snapshot([LIVE]))).toBe(0);
    expect(order0(log).state).toBe('RUNNING');
    expect(order0(log).evidenceSource).toBe(`live-worker ${LIVE}`);
  });

  it('live evidence stays bound to its own job: owner and receipt never come from a sibling', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // The published sibling has NO lane; the live launched job owns 'devin'.
    // With a stale snapshot the running evidence lapses and the fallback claim
    // must be the live job's — a RECEIVED here would mean the sibling's
    // missing owner leaked into the live job's evidence.
    const t = trace([job(PUB, 'published', null), job(LIVE, 'launched', 'devin')]);
    expect(await run(t, async () => snapshot([LIVE], STALE_AT))).toBe(0);
    const o = order0(log);
    expect(o.state).toBe('ASSIGNED');
    expect(o.evidenceSource).toBe(`claim:${LIVE}`);
    // The stale stamp is reported honestly by the classifier, not hidden.
    expect(o.missing).toEqual(['fresh running evidence']);
    // Symmetric check: live job without a lane cannot prove RUNNING even when
    // the published sibling has an owner — the snapshot membership is real but
    // the job cannot name an owner, so the published claim stands.
    log.mockClear();
    const noLane = trace([job(PUB, 'published', 'claude'), job(LIVE, 'launched', null)]);
    expect(await run(noLane, async () => snapshot([LIVE]))).toBe(0);
    const n = order0(log);
    expect(n.state).toBe('ASSIGNED');
    expect(n.evidenceSource).toBe(`claim:${PUB}`);
  });

  it('timestamp freshness gates RUNNING on the multi-job order too', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(PUB, 'published', 'claude'), job(LIVE, 'launched', 'devin')]);
    // Fresh snapshot: RUNNING.
    expect(await run(t, async () => snapshot([LIVE], '2026-11-14T11:45:00.000Z'))).toBe(0);
    expect(order0(log).state).toBe('RUNNING');
    // Stale snapshot (40 min old at NOW_MS): RUNNING lapses. The claim stays
    // bound to the live job — membership is real, only the stamp is stale —
    // and the classifier reports the missing freshness.
    log.mockClear();
    expect(await run(t, async () => snapshot([LIVE], STALE_AT))).toBe(0);
    const stale = order0(log);
    expect(stale.state).toBe('ASSIGNED');
    expect(stale.evidenceSource).toBe(`claim:${LIVE}`);
    expect(stale.missing).toEqual(['fresh running evidence']);
    // Future-skewed snapshot: not trusted either.
    log.mockClear();
    expect(await run(t, async () => snapshot([LIVE], FUTURE_AT))).toBe(0);
    const future = order0(log);
    expect(future.state).toBe('ASSIGNED');
    expect(future.evidenceSource).toBe(`claim:${LIVE}`);
  });

  it('prefers a live published sibling over a live launched one, trace order breaks ties', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const PUB2 = 'RQ-PHX-PUBLISHED2-363';
    const t = trace([job(LIVE, 'launched', 'devin'), job(PUB2, 'published', 'claude')]);
    expect(await run(t, async () => snapshot([LIVE, PUB2]))).toBe(0);
    const o = order0(log);
    expect(o.state).toBe('RUNNING');
    expect(o.evidenceSource).toBe(`live-worker ${PUB2}`);
    // Two live jobs of the same rank keep the trace's own ordering.
    log.mockClear();
    const t2 = trace([job('RQ-PHX-LIVE-A363', 'launched', 'devin'), job('RQ-PHX-LIVE-B363', 'launched', 'codex')]);
    expect(await run(t2, async () => snapshot(['RQ-PHX-LIVE-A363', 'RQ-PHX-LIVE-B363']))).toBe(0);
    expect(order0(log).evidenceSource).toBe('live-worker RQ-PHX-LIVE-A363');
  });
});
