/** RQ-PHX-ORDERHOLDRECOVERY367S: `fleet order-state` rechecking a queued
 * order as its lane hold lifts and its lane-hold source (queue/slots.json)
 * becomes unreadable — through the REAL readers, one isolated temp root.
 *
 * Mason's Nov 12 22:29/22:30 and Nov 13 13:13 Slack orders ask for fresh
 * evidence-backed ownership/status. This qualifies the merged
 * ORDERLANEBLOCKED366 wiring (queue/slots.json -> readLaneTargets ->
 * heldLaneBlocker -> BLOCKED) end-to-end: one cmdFleetOrderState deps
 * object — the real readOrderTrace and the real readLaneTargets bound to
 * the same temporary runs root, plus the real listLiveWorkers fed by an
 * injected runPs table — serves every invocation while the on-disk
 * evidence mutates between calls. Only clock/root and the live
 * process-table seams are injected; no trace or lane snapshot is.
 *
 * Fixture = a real runs root in the shapes the readers consume:
 * leader/MASON-INBOX.md `## <ET> (...) PRIORITY` entries, queue/prompts
 * <id>.md bodies citing `Serves Mason's <Mon D HH:MM> order.`, a
 * queue/ready.tsv row (`job repo lane tier prompt-path`) naming the held
 * lane, a <id>.launch marker (`launched <id> <lane> ...`) for the
 * sibling's launched job, metrics/jobs.jsonl, and queue/slots.json in the
 * dispatcher's own shape (direct lane map with target/floor/ceiling plus
 * held/held_reason/held_by/held_until/last_change, and the hard_cap +
 * last_change_by global keys).
 *
 * Arc: held lane -> lanes 'healthy' and order A reports BLOCKED on its
 * held queued lane; hold lifted -> 'healthy' and the order falls back to
 * RECEIVED; slots.json corrupted -> 'unavailable' and the text-mode stderr
 * warning fires once; deleted -> 'unavailable'; restored held -> 'healthy'
 * and BLOCKED again. The sibling order keeps its own launched-job claim
 * (ASSIGNED) through every phase — hold state never bleeds across orders —
 * and held_reason, held_by, local paths and fake private metadata never
 * reach stdout/stderr/JSON. Every invocation consumes exactly one fresh
 * trace read, one fresh slots read and one fresh process-table read.
 *
 * The gap this file once pinned (recorded for RQ-PHX-ORDERQUEUEDOWNER362)
 * is closed by RQ-PHX-ORDERQUEUEDLANE368: readOrderTrace used to emit
 * `lane: null` for every 'queued' job because the routed lane only exists
 * in queue/ready.tsv, which the trace never read — so heldLaneBlocker's
 * state === 'queued' AND lane !== null rule could never fire on real data.
 * The trace now fills a still-queued job's lane from ready.tsv, and the
 * second test pins that fixed shape directly.
 *
 * Bounds: every path, lane row, process row and timestamp is fake; the
 * temp root is removed in finally. This proves local read recovery of the
 * reporting path — not that Slack or a live Mac is reachable. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import { classifyOrder } from '../src/core/fleet/order-work-state.js';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = '2026-11-14T12:00:00.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
// '2026-11-14 06:00'/'05:30' ET are 2026-11-14T11:00/10:30 UTC (EST, UTC-5).
const ORDER_A_AT = '2026-11-14 06:00';
const ORDER_A_KEY = '11-14 06:00';
const ORDER_A_RECEIVED = '2026-11-14T11:00:00.000Z';
const ORDER_B_AT = '2026-11-14 05:30';
const ORDER_B_KEY = '11-14 05:30';
const ORDER_B_RECEIVED = '2026-11-14T10:30:00.000Z';

const JOB_A = 'RQ-PHX-HOLDRECOVERY367A'; // order A's queued job — queued on the held lane
const JOB_B = 'RQ-PHX-HOLDSIBLING367B'; // order B's launched job — never held, never live
const HELD_LANE = 'devin';
const FREE_LANE = 'claude';
const LAST_CHANGE = Math.floor(NOW_MS / 1000) - 600;

const INBOX = [
  `## ${ORDER_A_AT} ET (Mason, Fake slack) PRIORITY P0`,
  'Hold-recovery order A.',
  `## ${ORDER_B_AT} ET (Mason, Fake slack) PRIORITY P0`,
  'Unrelated order B.',
  '',
].join('\n');

const CITATION_A = "Serves Mason's Nov 14 06:00 order.";
const CITATION_B = "Serves Mason's Nov 14 05:30 order.";

/** The dispatcher's own slots.json shape: a direct lane map, global keys. */
const slots = (held: boolean): string => `${JSON.stringify({
  [HELD_LANE]: {
    target: 6, floor: 0, ceiling: 10,
    ...(held ? {
      held: true,
      held_reason: 'fake-account usage reset for fake-account@example.invalid',
      held_by: 'fake-operator',
      held_until: HELD_UNTIL,
    } : {}),
    last_change: LAST_CHANGE,
  },
  [FREE_LANE]: { target: 8, floor: 0, ceiling: 16, last_change: LAST_CHANGE },
  hard_cap: 10,
  last_change_by: 'dispatchd',
}, null, 1)}\n`;

// A healthy process table with no fleet workers at all.
const PS_IDLE = [
  '   100  2-01:02:03 /sbin/launchd',
  '   200     12:34 /usr/libexec/rapportd',
  '',
].join('\n');

interface OrderStateJson {
  v: number;
  generatedAt: string;
  sources: Record<'inbox' | 'prompts' | 'publishes' | 'queue', string>;
  live: string;
  lanes: string;
  orders: Array<{
    at: string; source: string; key: string;
    state: string; asOf: string; evidenceSource: string;
    missing: string[]; blocker: string | null; pr: string | null;
  }>;
}

type OrderStateDeps = NonNullable<Parameters<typeof cmdFleetOrderState>[1]>;

/** Strings that must never survive into any output: hold metadata, local
 * paths and fixture-only private values. The held lane's own name and
 * expiry instant are NOT private — the reporting contract's dependency
 * deliberately names lanes and timestamps only (order-lane-blocker.ts), so
 * `lane devin held until <iso>` is the sanctioned BLOCKED output. `root`
 * stays banned because it is a temp path. */
const privateTokens = (root: string): string[] => [
  'fake-account', 'fake-operator', 'held_reason', 'held_by', 'held_until',
  root, 'ready.tsv', `${JOB_A}.md`,
];

/** One real runs root: two inbox orders, order A's queued prompt + the
 * ready.tsv row that names its lane on a real host, order B's launched
 * prompt + .launch marker, metrics/jobs.jsonl and queue/slots.json. */
async function buildRunsRoot(root: string, held: boolean): Promise<void> {
  await mkdir(join(root, 'leader'), { recursive: true });
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'), INBOX);
  await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
  await writeFile(join(root, 'queue', 'prompts', `${JOB_A}.md`), `${CITATION_A}\n`);
  await writeFile(join(root, 'queue', 'prompts', `${JOB_B}.md`), `${CITATION_B}\n`);
  await writeFile(join(root, 'queue', 'ready.tsv'),
    `${JOB_A}\tphantom\t${HELD_LANE}\twork\t${join(root, 'queue', 'prompts', `${JOB_A}.md`)}\n`);
  await writeFile(join(root, `${JOB_B}.launch`), `launched ${JOB_B} ${FREE_LANE} pid 4202 base fakebase`);
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), '');
  await writeFile(join(root, 'queue', 'slots.json'), slots(held));
}

afterEach(() => vi.restoreAllMocks());

describe('fleet order-state hold recovery through real readers', () => {
  it('re-reads slots.json every invocation: held -> lifted -> corrupt -> deleted -> restored', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = (): string => log.mock.calls.map((c) => String(c[0])).join('\n');
    const json = (): OrderStateJson => JSON.parse(out()) as OrderStateJson;
    const byKey = (j: OrderStateJson) => new Map(j.orders.map((o) => [o.key, o]));
    const emitted = (): string => `${out()}\n${err.mock.calls.map((c) => String(c[0])).join('\n')}`;
    const expectClean = (root: string): void => {
      for (const token of privateTokens(root)) expect(emitted()).not.toContain(token);
    };

    const parent = await mkdtemp(join(tmpdir(), 'order-state-hold-367s-'));
    const root = join(parent, 'runs');
    let traceReads = 0;
    let laneReads = 0;
    let psReads = 0;
    const runPs = async (): Promise<string> => {
      psReads += 1;
      return PS_IDLE;
    };
    // The SAME deps object serves every invocation: the real readOrderTrace
    // and real readLaneTargets bound to the temp root, the controlled clock,
    // and the real listLiveWorkers over the injected process table.
    const deps: OrderStateDeps = {
      read: (o) => {
        traceReads += 1;
        return readOrderTrace({ ...(o ?? {}), runsDir: root });
      },
      now: () => NOW_MS,
      live: () => listLiveWorkers({ runPs, now: () => NOW_MS }),
      lanes: () => {
        laneReads += 1;
        return readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) });
      },
    };
    const run = (args: string[] = ['--json']): Promise<number> => cmdFleetOrderState(args, deps);
    try {
      await buildRunsRoot(root, true);

      // Phase 1 — held lane, healthy slots source. The trace picks the
      // queued job's routed lane up from ready.tsv, heldLaneBlocker's
      // queued-on-a-held-lane rule fires, and order A reports BLOCKED with
      // the held lane as its dependency — exactly what ORDERLANEBLOCKED366
      // intended. lanes stays 'healthy' and the hold is read fresh.
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.generatedAt).toBe(NOW_ISO);
        expect(j.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' });
        expect(j.live).toBe('healthy');
        expect(j.lanes).toBe('healthy');
        const orders = byKey(j);
        expect(j.orders).toHaveLength(2);
        const a = orders.get(ORDER_A_KEY)!;
        expect(a.state).toBe('BLOCKED');
        expect(a.asOf).toBe(NOW_ISO);
        expect(a.evidenceSource).toBe('slots.json');
        expect(a.missing).toEqual([]);
        expect(a.blocker).toBe(`lane ${HELD_LANE} held until ${HELD_UNTIL}`);
        expect(a.pr).toBeNull();
        const b = orders.get(ORDER_B_KEY)!;
        expect(b.state).toBe('ASSIGNED');
        expect(b.asOf).toBe(ORDER_B_RECEIVED);
        expect(b.evidenceSource).toBe(`claim:${JOB_B}`);
        expect(b.blocker).toBeNull();
        expect(b.pr).toBeNull();
        expectClean(root);
      }
      log.mockClear();
      err.mockClear();

      // Phase 2 — same held source, text mode: one contract line per
      // order, the blocked-on dependency, no warnings on stdout or stderr.
      expect(await run([])).toBe(0);
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        `${ORDER_A_AT} Fake slack BLOCKED as-of=${NOW_ISO} source=slots.json missing=none blocked-on=lane ${HELD_LANE} held until ${HELD_UNTIL}`,
        `${ORDER_B_AT} Fake slack ASSIGNED as-of=${ORDER_B_RECEIVED} source=claim:${JOB_B} missing=none`,
      ]);
      expect(err).not.toHaveBeenCalled();
      expectClean(root);
      log.mockClear();
      err.mockClear();

      // Phase 3 — the hold is lifted (the real unhold pops every held_*
      // key): same reads, no stale blocker survives, order A is still
      // RECEIVED — a queued job never mints ASSIGNED or RUNNING. Its
      // ready.tsv lane does name the owner now, so only the claim receipt
      // is still missing.
      await writeFile(join(root, 'queue', 'slots.json'), slots(false));
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.lanes).toBe('healthy');
        const a = byKey(j).get(ORDER_A_KEY)!;
        expect(a.state).toBe('RECEIVED');
        expect(a.asOf).toBe(ORDER_A_RECEIVED);
        expect(a.missing).toEqual(['durable claim receipt']);
        expect(a.blocker).toBeNull();
        expect(byKey(j).get(ORDER_B_KEY)!.state).toBe('ASSIGNED');
        expectClean(root);
      }
      log.mockClear();
      err.mockClear();

      // Phase 4 — corrupt slots.json: the lane source turns unavailable on
      // the very next read, no blocker is claimed, and the text run warns
      // on stderr exactly once while the order lines stay contract-shaped.
      await writeFile(join(root, 'queue', 'slots.json'), `{"${HELD_LANE}": {broken\n`);
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.lanes).toBe('unavailable');
        expect(byKey(j).get(ORDER_A_KEY)!.state).toBe('RECEIVED');
        expect(byKey(j).get(ORDER_A_KEY)!.blocker).toBeNull();
        expect(byKey(j).get(ORDER_B_KEY)!.state).toBe('ASSIGNED');
        expectClean(root);
      }
      log.mockClear();
      err.mockClear();
      expect(await run([])).toBe(0);
      expect(err.mock.calls.map((c) => c[0])).toEqual(['warning: lane holds unavailable; BLOCKED not checked']);
      expect(out()).not.toContain('blocked-on');
      expectClean(root);
      log.mockClear();
      err.mockClear();

      // Phase 5 — slots.json deleted outright: still 'unavailable', still
      // no invented blocker, still no ASSIGNED/RUNNING promotion.
      await rm(join(root, 'queue', 'slots.json'));
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.lanes).toBe('unavailable');
        expect(byKey(j).get(ORDER_A_KEY)!.state).toBe('RECEIVED');
        expect(byKey(j).get(ORDER_A_KEY)!.blocker).toBeNull();
        expect(byKey(j).get(ORDER_B_KEY)!.state).toBe('ASSIGNED');
        expectClean(root);
      }
      log.mockClear();
      err.mockClear();

      // Phase 6 — the held source is restored: the very next read recovers
      // 'healthy' and BLOCKED — no state is pinned between invocations in
      // either direction — and the sibling is untouched throughout.
      await writeFile(join(root, 'queue', 'slots.json'), slots(true));
      expect(await run()).toBe(0);
      {
        const j = json();
        expect(j.lanes).toBe('healthy');
        const a = byKey(j).get(ORDER_A_KEY)!;
        expect(a.state).toBe('BLOCKED');
        expect(a.blocker).toBe(`lane ${HELD_LANE} held until ${HELD_UNTIL}`);
        const b = byKey(j).get(ORDER_B_KEY)!;
        expect(b.state).toBe('ASSIGNED');
        expect(b.evidenceSource).toBe(`claim:${JOB_B}`);
        expectClean(root);
      }

      // Seven command invocations, seven fresh trace reads, seven fresh
      // slots.json reads and seven fresh process-table reads through the
      // same seams — changed evidence was consumed every time.
      expect(traceReads).toBe(7);
      expect(laneReads).toBe(7);
      expect(psReads).toBe(7);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('pins the fixed trace shape: the queued job on the held lane reads its ready.tsv lane', async () => {
    // The smallest reproduction of the once-unreachable BLOCKED: with every
    // real queue artifact in place — the citing prompt, the ready.tsv row
    // naming the held lane and a healthy held slots.json — the real
    // readOrderTrace emits the queued job with its routed lane, the one
    // shape heldLaneBlocker needs, so classifyOrder reports BLOCKED.
    const parent = await mkdtemp(join(tmpdir(), 'order-state-hold-367s-'));
    const root = join(parent, 'runs');
    try {
      await buildRunsRoot(root, true);
      const [trace, lanes] = await Promise.all([
        readOrderTrace({ runsDir: root, now: () => NOW_MS }),
        readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) }),
      ]);
      const orderA = trace.orders.find((o) => o.key === ORDER_A_KEY)!;
      const jobA = orderA.jobs.find((j) => j.id === JOB_A);
      expect(jobA).toEqual({ id: JOB_A, lane: HELD_LANE, state: 'queued', url: null });
      expect(lanes.sourceState).toBe('healthy');
      expect(lanes.lanes.find((row) => row.lane === HELD_LANE)?.held).toBe(true);
      expect(classifyOrder(orderA, trace.generatedAt, NOW_ISO, undefined, lanes).state).toBe('BLOCKED');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
