/** RQ-PHX-ORDERCLIDISKRECOVERY363S: `fleet order-state` recovering order
 * ownership from a missing local evidence source through the REAL readers.
 *
 * Every sibling lifecycle test injects a completed OrderTraceV1; this one
 * drives cmdFleetOrderState with the real readOrderTrace bound to ONE
 * isolated temporary runs root (its supported `runsDir` option — the only
 * boundary injected on the trace side) and the real listLiveWorkers fed by
 * an injected runPs process table (the documented test seam; no /bin/ps is
 * spawned). classifyOrder, parseOrderCitations and the trace file scans are
 * never stubbed, and every fixture is derived from what those readers
 * actually parse: leader/MASON-INBOX.md `## <ET> (...) PRIORITY` entries,
 * <id>.prompt bodies citing `Serves Mason's <Mon D HH:MM> order.`,
 * <id>.launch markers (`launched <id> <lane> ...`) and metrics/jobs.jsonl
 * publish rows.
 *
 * The arc: absent runs root -> every source reports its real 'missing'
 * state and no order is invented; inbox only -> both orders RECEIVED with
 * prompts/publishes still 'missing'; full on-disk evidence -> ASSIGNED from
 * each job's own claim receipt, then RUNNING once the live table names
 * order A's job; the prompt citation replaced with an unmatched key, then
 * deleted -> the claim receipt is gone on the very next read (nothing is
 * cached, in either direction); restored -> RUNNING again. Order B keeps
 * its own published job and stays ASSIGNED throughout, and an unrelated
 * live worker never attaches — ownership cannot bleed between orders.
 *
 * This proves synthetic disk recovery of the reporting path, NOT a live
 * Mac connection: every path, process row, PR url and timestamp is fake,
 * and the temp root is removed in finally. */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = '2026-11-14T12:00:00.000Z';
// '2026-11-14 06:00'/'05:30' ET are 2026-11-14T11:00/10:30 UTC (EST, UTC-5).
const ORDER_A_AT = '2026-11-14 06:00';
const ORDER_A_KEY = '11-14 06:00';
const ORDER_A_RECEIVED = '2026-11-14T11:00:00.000Z';
const ORDER_B_AT = '2026-11-14 05:30';
const ORDER_B_KEY = '11-14 05:30';
const ORDER_B_RECEIVED = '2026-11-14T10:30:00.000Z';

const JOB_A = 'RQ-PHX-ORDERDISK363A'; // order A's launched job — live from phase 3 on
const JOB_B = 'RQ-PHX-ORDERDISK363B'; // order B's published job — never live
const JOB_X = 'RQ-PHX-UNRELATED363X'; // unrelated live worker with no prompt file
const PR_B = 'https://example.invalid/pr/364';

const INBOX = [
  '## 2026-11-14 06:00 ET (Mason, Fake console) PRIORITY P0',
  'Disk-recovery order A.',
  '## 2026-11-14 05:30 ET (Mason, Fake console) PRIORITY P0',
  'Unrelated order B.',
  '',
].join('\n');

const CITATION_A = "Serves Mason's Nov 14 06:00 order.";
const CITATION_B = "Serves Mason's Nov 14 05:30 order.";
const CITATION_ORPHAN = "Serves Mason's Nov 14 07:00 order."; // key no inbox order has

// Distinct fixed mtimes for prompt rewrites so the trace's mtime-keyed
// citation cache must re-parse instead of replaying stale keys.
const PROMPT_MTIME_1 = new Date('2026-11-13T10:00:00.000Z');
const PROMPT_MTIME_2 = new Date('2026-11-13T11:00:00.000Z');

const FAKE_RUNS = '/fake-home/.ashlr-runs';
const launchRow = (pid: number, etime: string, job: string, lane: string, tier: string): string =>
  `  ${pid}  ${etime} /bin/bash ${FAKE_RUNS}/bin/launch.sh ${job} phantom ${lane} ${tier}`;

const PS_IDLE = [
  '   100  2-01:02:03 /sbin/launchd',
  '   200     12:34 /usr/libexec/rapportd',
  '',
].join('\n');

const PS_LIVE = [
  '   100  2-01:02:03 /sbin/launchd',
  launchRow(4210, '05:12', JOB_A, 'devin', 'work'),
  launchRow(4311, '03:45', JOB_X, 'codex-local', 'mid'),
  '',
].join('\n');

interface OrderStateJson {
  v: number;
  generatedAt: string;
  sources: Record<'inbox' | 'prompts' | 'publishes', string>;
  live: string;
  orders: Array<{
    at: string; source: string; key: string;
    state: string; asOf: string; evidenceSource: string;
    missing: string[]; pr: string | null;
  }>;
}

type OrderStateDeps = NonNullable<Parameters<typeof cmdFleetOrderState>[1]>;

afterEach(() => vi.restoreAllMocks());

describe('fleet order-state disk recovery', () => {
  it('recovers order ownership from missing on-disk evidence through the real CLI readers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = (): string => log.mock.calls.map((c) => String(c[0])).join('\n');
    const json = (): OrderStateJson => JSON.parse(out()) as OrderStateJson;
    const byKey = (j: OrderStateJson) => new Map(j.orders.map((o) => [o.key, o]));

    // ONE isolated temporary runs root for every read. `runs` is deliberately
    // left absent until the inbox phase so the first reads see genuinely
    // missing sources; only its parent exists.
    const parent = await mkdtemp(join(tmpdir(), 'order-state-disk-363s-'));
    const root = join(parent, 'runs');
    let traceReads = 0;
    let psReads = 0;
    let psResult: string | Error = new Error('fake ps failure');
    const runPs = async (): Promise<string> => {
      psReads += 1;
      if (psResult instanceof Error) throw psResult;
      return psResult;
    };
    // The SAME deps object serves every invocation: the real readOrderTrace
    // pinned to the temp root, the controlled clock, and the real
    // listLiveWorkers over the injected process table.
    const deps: OrderStateDeps = {
      read: (o) => {
        traceReads += 1;
        return readOrderTrace({ ...(o ?? {}), runsDir: root });
      },
      now: () => NOW_MS,
      live: () => listLiveWorkers({ runPs, now: () => NOW_MS }),
    };
    const run = (args: string[] = ['--json']): Promise<number> => cmdFleetOrderState(args, deps);
    try {
      // Phase 1a — runs root absent: every trace source reports its real
      // 'missing' classification and the live reader reports 'unavailable';
      // no order is invented.
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.generatedAt).toBe(NOW_ISO);
        expect(j.sources).toEqual({ inbox: 'missing', prompts: 'missing', publishes: 'missing' });
        expect(j.live).toBe('unavailable');
        expect(j.orders).toEqual([]);
      }
      log.mockClear();
      expect(await run([])).toBe(0);
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        'warning: order sources not healthy: inbox=missing prompts=missing publishes=missing',
        'warning: live workers unavailable; RUNNING not checked',
      ]);
      log.mockClear();

      // Phase 1b — inbox evidence only: the two orders exist on disk but the
      // prompt and publish sources are still missing, so both classify
      // RECEIVED — the missing sources are reported, not papered over with
      // an assignment.
      await mkdir(join(root, 'leader'), { recursive: true });
      await writeFile(join(root, 'leader', 'MASON-INBOX.md'), INBOX);
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.sources).toEqual({ inbox: 'healthy', prompts: 'missing', publishes: 'missing' });
        expect(j.live).toBe('unavailable');
        const orders = byKey(j);
        expect(j.orders).toHaveLength(2);
        for (const [key, at, received] of [
          [ORDER_A_KEY, ORDER_A_AT, ORDER_A_RECEIVED],
          [ORDER_B_KEY, ORDER_B_AT, ORDER_B_RECEIVED],
        ] as const) {
          const o = orders.get(key)!;
          expect(o.at).toBe(at);
          expect(o.state).toBe('RECEIVED');
          expect(o.asOf).toBe(received);
          expect(o.source).toBe('Fake console');
          expect(o.evidenceSource).toBe('receivedAt');
          expect(o.missing).toEqual(['named owner', 'durable claim receipt']);
          expect(o.pr).toBeNull();
        }
      }
      log.mockClear();

      // Phase 2 — the minimal real-format evidence appears: one .prompt
      // citation + .launch marker per job and a metrics/jobs.jsonl publish
      // row for order B's job (order A stays 'launched'). With a healthy
      // EMPTY process table both orders are ASSIGNED from their own claim
      // receipts — live evidence is what separates ASSIGNED from RUNNING.
      await writeFile(join(root, `${JOB_A}.prompt`), `${CITATION_A}\n`);
      await writeFile(join(root, `${JOB_A}.launch`), `launched ${JOB_A} devin pid 4201 base fakebase`);
      await writeFile(join(root, `${JOB_B}.prompt`), `${CITATION_B}\n`);
      await writeFile(join(root, `${JOB_B}.launch`), `launched ${JOB_B} claude pid 4202 base fakebase`);
      await mkdir(join(root, 'metrics'), { recursive: true });
      await writeFile(join(root, 'metrics', 'jobs.jsonl'),
        `${JSON.stringify({ event: 'publish', job: JOB_B, url: PR_B, ts: '2026-11-14T11:40:00.000Z' })}\n`);
      psResult = PS_IDLE;
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' });
        expect(j.live).toBe('healthy');
        const orders = byKey(j);
        const a = orders.get(ORDER_A_KEY)!;
        expect(a.state).toBe('ASSIGNED');
        expect(a.asOf).toBe(ORDER_A_RECEIVED);
        expect(a.evidenceSource).toBe(`claim:${JOB_A}`);
        expect(a.missing).toEqual([]);
        expect(a.pr).toBeNull();
        const b = orders.get(ORDER_B_KEY)!;
        expect(b.state).toBe('ASSIGNED');
        expect(b.asOf).toBe(ORDER_B_RECEIVED);
        expect(b.evidenceSource).toBe(`claim:${JOB_B}`);
        expect(b.pr).toBe(PR_B);
      }
      log.mockClear();

      // Phase 3 — the process table gains a launch.sh row for order A's job
      // plus an unrelated worker. Order A flips to RUNNING stamped at the
      // live snapshot time; order B stays ASSIGNED and the unrelated worker
      // mints no order.
      psResult = PS_LIVE;
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.live).toBe('healthy');
        const orders = byKey(j);
        const a = orders.get(ORDER_A_KEY)!;
        expect(a.state).toBe('RUNNING');
        expect(a.asOf).toBe(NOW_ISO);
        expect(a.evidenceSource).toBe(`live-worker ${JOB_A}`);
        expect(a.missing).toEqual([]);
        expect(a.pr).toBeNull();
        const b = orders.get(ORDER_B_KEY)!;
        expect(b.state).toBe('ASSIGNED');
        expect(b.evidenceSource).toBe(`claim:${JOB_B}`);
        expect(j.orders).toHaveLength(2);
      }
      log.mockClear();

      // Phase 4 — replace order A's prompt citation with a key no inbox
      // order has. Launch marker, live worker and clock are unchanged, yet
      // the claim receipt is gone on the very next read: the earlier
      // RECEIVED/ASSIGNED/RUNNING receipt was never cached.
      await writeFile(join(root, `${JOB_A}.prompt`), `${CITATION_ORPHAN}\n`);
      await utimes(join(root, `${JOB_A}.prompt`), PROMPT_MTIME_1, PROMPT_MTIME_1);
      expect(await run()).toBe(0);
      {
        const j = json();
        const orders = byKey(j);
        const a = orders.get(ORDER_A_KEY)!;
        expect(a.state).toBe('RECEIVED');
        expect(a.asOf).toBe(ORDER_A_RECEIVED);
        expect(a.evidenceSource).toBe('receivedAt');
        expect(a.missing).toEqual(['named owner', 'durable claim receipt']);
        expect(a.pr).toBeNull();
        expect(orders.get(ORDER_B_KEY)!.state).toBe('ASSIGNED');
        expect(j.orders).toHaveLength(2);
      }
      log.mockClear();

      // Phase 5 — restore the real citation: the same deps and root recover
      // RUNNING on the next read, proving phase 4's loss was fresh-read
      // behavior and not a cache stuck in either direction.
      await writeFile(join(root, `${JOB_A}.prompt`), `${CITATION_A}\n`);
      await utimes(join(root, `${JOB_A}.prompt`), PROMPT_MTIME_2, PROMPT_MTIME_2);
      expect(await run()).toBe(0);
      {
        const a = byKey(json()).get(ORDER_A_KEY)!;
        expect(a.state).toBe('RUNNING');
        expect(a.asOf).toBe(NOW_ISO);
        expect(a.evidenceSource).toBe(`live-worker ${JOB_A}`);
      }
      log.mockClear();

      // Phase 6 — remove the prompt outright: the receipt disappears again
      // even though the launch marker, live worker and inbox line remain.
      // The vanished path is also evicted from the citation cache, so any
      // later re-create is read fresh.
      await rm(join(root, `${JOB_A}.prompt`));
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' });
        const orders = byKey(j);
        const a = orders.get(ORDER_A_KEY)!;
        expect(a.state).toBe('RECEIVED');
        expect(a.asOf).toBe(ORDER_A_RECEIVED);
        expect(a.evidenceSource).toBe('receivedAt');
        expect(a.missing).toEqual(['named owner', 'durable claim receipt']);
        expect(orders.get(ORDER_B_KEY)!.state).toBe('ASSIGNED');
        expect(j.orders).toHaveLength(2);
      }

      // Eight command invocations, eight fresh trace reads of the same temp
      // root and eight fresh process-table reads through the same runPs —
      // changed disk and live evidence was consumed every time.
      expect(traceReads).toBe(8);
      expect(psReads).toBe(8);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
