/** RQ-PHX-ORDERRUNNINGLIVE359: `fleet order-state` joins the order trace with
 * the live-worker snapshot, so an order whose launched/published job has a
 * live worker reads RUNNING. Every dep is injected — no process is spawned
 * and no real ~/.ashlr-runs is read. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const GENERATED = '2026-11-14T11:00:00.000Z';
const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const LIVE_AT = '2026-11-14T11:59:00.000Z';
const PR_URL = 'https://github.com/ashlrai/phantom/pull/456';
const JOB = 'RQ-PHX-FAKEJOB1';
// '2026-11-14 06:00' ET is 2026-11-14T11:00:00.000Z (EST, UTC-5).
const ORDER_AT = '2026-11-14 06:00';
const RECEIVED_ISO = '2026-11-14T11:00:00.000Z';

const job = (id: string, state: OrderTraceJob['state'], url: string | null = null, lane: string | null = 'devin'): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (jobs: OrderTraceJob[]): OrderTraceV1 => ({
  v: 1, generatedAt: GENERATED,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: ORDER_AT, source: 'Phantom desktop', key: '11-14 06:00', jobs }],
});

const snapshot = (jobIds: string[], state: 'healthy' | 'unavailable' = 'healthy'): LiveWorkersSnapshot => ({
  v: 1, generatedAt: LIVE_AT, sourceState: state,
  workers: state === 'healthy'
    ? jobIds.map((j, i) => ({ pid: 9000 + i, job: j, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 120 }))
    : [],
  leaders: [], orchestratorAgents: 0,
});

const run = (args: string[], t: OrderTraceV1, live: () => Promise<LiveWorkersSnapshot>) =>
  cmdFleetOrderState(args, { read: async () => t, now: () => NOW_MS, live });
const out = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map((c) => String(c[0])).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('fleet order-state with live workers', () => {
  it('a launched job with a live worker reads RUNNING at the snapshot time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const live = vi.fn(async () => snapshot([JOB, 'RQ-PHX-OTHERJOB9']));
    expect(await run([], trace([job(JOB, 'launched')]), live)).toBe(0);
    expect(live).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-11-14 06:00 Phantom desktop RUNNING as-of=${LIVE_AT} source=live-worker ${JOB} missing=none`,
    ]);
  });
  it('JSON reports the RUNNING classification, the live source and live=healthy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--json'], trace([job(JOB, 'published')]), async () => snapshot([JOB]))).toBe(0);
    const parsed = JSON.parse(out(log));
    expect(parsed.live).toBe('healthy');
    expect(parsed.orders[0].state).toBe('RUNNING');
    expect(parsed.orders[0].asOf).toBe(LIVE_AT);
    expect(parsed.orders[0].evidenceSource).toBe(`live-worker ${JOB}`);
    expect(out(log)).not.toContain('9000'); // worker pids never leave the snapshot
  });
  it('the same order stays ASSIGNED when its job is missing from the snapshot', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace([job(JOB, 'launched')]), async () => snapshot(['RQ-PHX-OTHERJOB9']))).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-11-14 06:00 Phantom desktop ASSIGNED as-of=${RECEIVED_ISO} source=claim:${JOB} missing=none`,
    ]);
  });
  it('a merged job with a pull url stays VERIFIED even while its worker is live', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace([job(JOB, 'merged', PR_URL)]), async () => snapshot([JOB]))).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-11-14 06:00 Phantom desktop VERIFIED as-of=${GENERATED} source=order-trace missing=none pr=${PR_URL}`,
    ]);
  });
  it('a queued job id in the live set does not make the order RUNNING', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // The queued job is live but the most advanced job (launched) is not.
    expect(await run([], trace([job('RQ-PHX-FAKEJOB2', 'launched'), job(JOB, 'queued')]), async () => snapshot([JOB]))).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-11-14 06:00 Phantom desktop ASSIGNED as-of=${RECEIVED_ISO} source=claim:RQ-PHX-FAKEJOB2 missing=none`,
    ]);
    log.mockClear();
    // An order whose only job is queued never gets a claim or running evidence.
    expect(await run([], trace([job(JOB, 'queued')]), async () => snapshot([JOB]))).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-11-14 06:00 Phantom desktop RECEIVED as-of=${RECEIVED_ISO} source=receivedAt missing=durable claim receipt`,
    ]);
  });
  it('a throwing live reader still exits 0 with the warning and today\'s states', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(JOB, 'launched')]);
    const assigned = `2026-11-14 06:00 Phantom desktop ASSIGNED as-of=${RECEIVED_ISO} source=claim:${JOB} missing=none`;
    expect(await run([], t, async () => { throw new Error('ps failed'); })).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual(['warning: live workers unavailable; RUNNING not checked', assigned]);
    log.mockClear();
    expect(await run([], t, async () => snapshot([JOB], 'unavailable'))).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual(['warning: live workers unavailable; RUNNING not checked', assigned]);
    log.mockClear();
    expect(await run(['--json'], t, async () => snapshot([JOB], 'unavailable'))).toBe(0);
    const parsed = JSON.parse(out(log));
    expect(parsed.live).toBe('unavailable');
    expect(parsed.orders[0].state).toBe('ASSIGNED');
    expect(parsed.orders[0].evidenceSource).toBe(`claim:${JOB}`);
  });
});
