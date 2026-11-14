/** RQ-PHX-ORDERWORKERLIFECYCLE361S: order-state worker lifecycle qualification.
 *
 * Mason's Nov 12 22:29 reporting contract and Nov 13 13:13 request for fresh
 * runtime execution evidence require that an agent rechecking a STOPPED
 * worker sees current process evidence — never yesterday's RUNNING claim.
 * One unchanged command configuration (a single deps object, one live
 * reader, one runPs) is driven through successive cmdFleetOrderState reads
 * while the injected process table changes underneath it:
 *
 *   launch.sh rows for the order's job -> RUNNING at the snapshot as-of
 *   healthy empty process table        -> RUNNING removed (ASSIGNED)
 *   runPs rejection                    -> live=unavailable + warning,
 *                                         RUNNING cannot be retained
 *   launch.sh rows again               -> RUNNING restored with a new as-of
 *
 * The live side is the REAL listLiveWorkers/parsePsTable path fed by an
 * injected runPs — classification is never stubbed — so every transition is
 * consumed from changed process evidence on each invocation, not from a
 * per-assertion mock (psReads counts exactly one fresh read per command
 * call). A second order whose job never appears in the table stays ASSIGNED
 * throughout, proving worker membership is job-bound, and a
 * launched-but-never-live order proves a launch receipt alone never proves
 * a current worker.
 *
 * This proves the reporting path re-reads the process table on every
 * invocation and classifies from THAT read: stale RUNNING evidence cannot
 * survive a healthy empty table or an unavailable read. It is NOT proof of
 * a live host connection — runPs is injected, no /bin/ps is spawned, no
 * ~/.ashlr-runs is read, and every value is fake. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const GENERATED = '2026-11-14T11:00:00.000Z';
// Controlled clock; each phase advances it so a restored RUNNING carries a
// new as-of instead of reusing the first snapshot's stamp.
const T_LIVE = Date.parse('2026-11-14T12:00:00.000Z');
const T_IDLE = Date.parse('2026-11-14T12:05:00.000Z');
const T_REJECT = Date.parse('2026-11-14T12:10:00.000Z');
const T_AGAIN = Date.parse('2026-11-14T12:20:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

// '2026-11-14 06:00' ET is 2026-11-14T11:00:00.000Z and '05:30' ET is
// 2026-11-14T10:30:00.000Z (EST, UTC-5).
const ORDER_A_AT = '2026-11-14 06:00';
const ORDER_A_KEY = '11-14 06:00';
const ORDER_A_RECEIVED = '2026-11-14T11:00:00.000Z';
const ORDER_B_AT = '2026-11-14 05:30';
const ORDER_B_KEY = '11-14 05:30';
const ORDER_B_RECEIVED = '2026-11-14T10:30:00.000Z';

const JOB_A = 'RQ-PHX-ORDERLIFECYCLE361'; // order A's launched job — live in phases 1 and 4
const JOB_B = 'RQ-PHX-SIBLINGORDER361'; // order B's launched job — never live
const JOB_X = 'RQ-PHX-UNRELATEDWORK361'; // unrelated worker live beside them

// The same launched order trace for every read: only the process evidence
// changes between invocations.
const TRACE: OrderTraceV1 = {
  v: 1,
  generatedAt: GENERATED,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [
    { at: ORDER_A_AT, source: 'Phantom desktop', key: ORDER_A_KEY,
      jobs: [{ id: JOB_A, lane: 'devin', state: 'launched', url: null }] },
    { at: ORDER_B_AT, source: 'Phantom desktop', key: ORDER_B_KEY,
      jobs: [{ id: JOB_B, lane: 'claude', state: 'launched', url: null }] },
  ],
};

// launch.sh rows in the real dispatcher shape (/bin/bash <runs>/bin/launch.sh
// <job> <repo> <lane> <tier>), plus an agent child carrying the job id —
// the parser attributes it to the worker instead of counting it loose.
const FAKE_RUNS = '/Users/fake/.ashlr-runs';
const launchRow = (pid: number, etime: string, job: string): string =>
  `  ${pid}  ${etime} /bin/bash ${FAKE_RUNS}/bin/launch.sh ${job} phantom devin work`;

const PS_LIVE = [
  '   100  2-01:02:03 /sbin/launchd',
  launchRow(4210, '05:12', JOB_A),
  launchRow(4311, '03:45', JOB_X),
  `  4400  04:30 codex exec --cd /Users/fake/wt/${JOB_X} --json`,
  '',
].join('\n');

// The worker returns later: a NEW pid and etime, not the phase-1 process.
const PS_LIVE_AGAIN = [
  '   100  2-01:02:03 /sbin/launchd',
  launchRow(4500, '00:42', JOB_A),
  launchRow(4311, '03:45', JOB_X),
  '',
].join('\n');

// A healthy read with no fleet processes at all.
const PS_IDLE = [
  '   100  2-01:02:03 /sbin/launchd',
  '   200     12:34 /usr/libexec/rapportd',
  '   300      01:11 /usr/bin/top -l 1',
  '',
].join('\n');

afterEach(() => vi.restoreAllMocks());

describe('fleet order-state worker lifecycle', () => {
  it('re-reads process evidence on every invocation: RUNNING -> ASSIGNED -> unavailable -> RUNNING', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = (): string => log.mock.calls.map((c) => String(c[0])).join('\n');
    const jsonOrders = () => {
      const parsed = JSON.parse(out()) as {
        live: string;
        orders: Array<{ key: string; state: string; asOf: string; evidenceSource: string; missing: string[] }>;
      };
      return { parsed, byKey: new Map(parsed.orders.map((o) => [o.key, o])) };
    };

    // ONE command instance for the whole lifecycle: the same deps object,
    // the same live reader and the same runPs serve every read. Only
    // clockMs/psResult change between invocations.
    let clockMs = T_LIVE;
    let psResult: string | Error = PS_LIVE;
    let psReads = 0;
    const runPs = async (): Promise<string> => {
      psReads += 1;
      if (psResult instanceof Error) throw psResult;
      return psResult;
    };
    const deps = {
      read: async () => TRACE,
      now: () => clockMs,
      live: () => listLiveWorkers({ runPs, now: () => clockMs }),
    };
    const run = (args: string[] = ['--json']): Promise<number> => cmdFleetOrderState(args, deps);

    // Phase 1 — a real launch.sh row for the order's job proves RUNNING.
    expect(await run()).toBe(0);
    expect(psReads).toBe(1);
    {
      const { parsed, byKey } = jsonOrders();
      expect(parsed.live).toBe('healthy');
      const a = byKey.get(ORDER_A_KEY);
      expect(a?.state).toBe('RUNNING');
      expect(a?.asOf).toBe(iso(T_LIVE));
      expect(a?.evidenceSource).toBe(`live-worker ${JOB_A}`);
      expect(a?.missing).toEqual([]);
      // The unrelated live worker does not leak: order B's job is not in
      // the snapshot, so its launch receipt alone stays ASSIGNED.
      const b = byKey.get(ORDER_B_KEY);
      expect(b?.state).toBe('ASSIGNED');
      expect(b?.asOf).toBe(ORDER_B_RECEIVED);
      expect(b?.evidenceSource).toBe(`claim:${JOB_B}`);
      expect(out()).not.toContain('4210'); // worker pids never leave the snapshot
    }
    log.mockClear();

    // Phase 2 — a healthy EMPTY process table removes RUNNING. The read
    // succeeded, so live stays 'healthy'; the classification simply has no
    // worker for the job anymore.
    clockMs = T_IDLE;
    psResult = PS_IDLE;
    expect(await run()).toBe(0);
    expect(psReads).toBe(2);
    {
      const { parsed, byKey } = jsonOrders();
      expect(parsed.live).toBe('healthy');
      const a = byKey.get(ORDER_A_KEY);
      expect(a?.state).toBe('ASSIGNED');
      expect(a?.asOf).toBe(ORDER_A_RECEIVED);
      expect(a?.evidenceSource).toBe(`claim:${JOB_A}`);
      expect(byKey.get(ORDER_B_KEY)?.state).toBe('ASSIGNED');
    }
    log.mockClear();

    // Phase 3 — the reader rejects: listLiveWorkers degrades to
    // 'unavailable', the text view warns, and no earlier RUNNING survives.
    clockMs = T_REJECT;
    psResult = new Error('fake ps failure');
    expect(await run([])).toBe(0);
    expect(psReads).toBe(3);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'warning: live workers unavailable; RUNNING not checked',
      `${ORDER_A_AT} Phantom desktop ASSIGNED as-of=${ORDER_A_RECEIVED} source=claim:${JOB_A} missing=none`,
      `${ORDER_B_AT} Phantom desktop ASSIGNED as-of=${ORDER_B_RECEIVED} source=claim:${JOB_B} missing=none`,
    ]);
    log.mockClear();
    expect(await run()).toBe(0);
    expect(psReads).toBe(4);
    {
      const { parsed, byKey } = jsonOrders();
      expect(parsed.live).toBe('unavailable');
      const a = byKey.get(ORDER_A_KEY);
      expect(a?.state).toBe('ASSIGNED'); // cannot retain the phase-1 RUNNING
      expect(a?.asOf).toBe(ORDER_A_RECEIVED);
      expect(a?.evidenceSource).toBe(`claim:${JOB_A}`);
    }
    log.mockClear();

    // Phase 4 — a matching live process returns: RUNNING is restored, but
    // stamped at the NEW snapshot time, not yesterday's or phase-1's.
    clockMs = T_AGAIN;
    psResult = PS_LIVE_AGAIN;
    expect(await run()).toBe(0);
    expect(psReads).toBe(5);
    {
      const { parsed, byKey } = jsonOrders();
      expect(parsed.live).toBe('healthy');
      const a = byKey.get(ORDER_A_KEY);
      expect(a?.state).toBe('RUNNING');
      expect(a?.asOf).toBe(iso(T_AGAIN));
      expect(a?.asOf).not.toBe(iso(T_LIVE));
      expect(a?.evidenceSource).toBe(`live-worker ${JOB_A}`);
      expect(byKey.get(ORDER_B_KEY)?.state).toBe('ASSIGNED');
    }

    // Five command invocations, five fresh process-table reads through the
    // same runPs — changed evidence was consumed each time, never cached.
    expect(psReads).toBe(5);
  });
});
