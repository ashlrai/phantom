/** RQ-PHX-ORDERQUEUEDLANE368: a still-queued job's routed lane now reaches
 * the order trace from queue/ready.tsv, so the held-lane BLOCKED state is
 * reachable on real data (Mason's Nov 12 22:29 order — a BLOCKED report
 * must name a specific dependency). Before this, the trace emitted
 * lane: null for every queued job and heldLaneBlocker's
 * queued-on-a-held-lane rule could never fire.
 *
 * Fixture = a real runs root in the shapes the readers consume:
 * leader/MASON-INBOX.md `## <ET> (...) PRIORITY` entries, queue/prompts
 * <id>.md bodies citing `Serves Mason's <Mon D HH:MM> order.`, a
 * queue/ready.tsv legacy five-column row (`job repo lane tier path`), an
 * optional <id>.launch marker, an empty metrics/jobs.jsonl and
 * queue/slots.json in the dispatcher's own shape. Every path, lane row and
 * timestamp is fake; the temp root is removed in finally. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import { heldLaneBlocker } from '../src/core/fleet/order-lane-blocker.js';
import { classifyOrder } from '../src/core/fleet/order-work-state.js';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { queuedLanesFromText } from '../src/core/fleet/order-queued-lanes.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = '2026-11-14T12:00:00.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const ORDER_KEY = '11-14 04:30';
const JOB_A = 'RQ-PHX-FAKEA368';
const HELD_LANE = 'codex-personal';
const LAUNCHED_LANE = 'devin';

const INBOX = '## 2026-11-14 04:30 ET (Mason, Fake console) PRIORITY P0\nQueued-lane order.\n';
const CITATION = "Serves Mason's Nov 14 04:30 order.\n";

/** The dispatcher's own slots.json shape: a direct lane map, global keys. */
const slots = (): string => `${JSON.stringify({
  [HELD_LANE]: {
    target: 1, floor: 0, ceiling: 4,
    held: true,
    held_reason: 'fake-account usage reset for fake-account@example.invalid',
    held_by: 'fake-operator',
    held_until: HELD_UNTIL,
    last_change: Math.floor(NOW_MS / 1000) - 600,
  },
  [LAUNCHED_LANE]: { target: 6, floor: 0, ceiling: 10, last_change: Math.floor(NOW_MS / 1000) - 600 },
  hard_cap: 10,
  last_change_by: 'dispatchd',
}, null, 1)}\n`;

const PS_IDLE = '   100  2-01:02:03 /sbin/launchd\n   200     12:34 /usr/libexec/rapportd\n';

afterEach(() => vi.restoreAllMocks());

/** One real runs root: the inbox order, the citing prompt, slots.json
 * holding HELD_LANE until HELD_UNTIL, an empty metrics ledger and — unless
 * `ready` is null — a legacy ready.tsv row routing the job to `lane`. */
async function buildRunsRoot(root: string, opts: { ready: string | null; launch?: string }): Promise<void> {
  await mkdir(join(root, 'leader'), { recursive: true });
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'), INBOX);
  await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
  const prompt = join(root, 'queue', 'prompts', `${JOB_A}.md`);
  await writeFile(prompt, CITATION);
  if (opts.ready !== null) {
    await writeFile(join(root, 'queue', 'ready.tsv'), `${JOB_A}\tphantom\t${opts.ready}\twork\t${prompt}\n`);
  }
  if (opts.launch !== undefined) {
    await writeFile(join(root, `${JOB_A}.launch`), `launched ${JOB_A} ${opts.launch} pid 4201 base fakebase`);
  }
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), '');
  await writeFile(join(root, 'queue', 'slots.json'), slots());
}

async function makeRoot(opts: { ready: string | null; launch?: string }): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'order-queued-lane-368-'));
  const root = join(parent, 'runs');
  await buildRunsRoot(root, opts);
  return { parent, root };
}

describe('queued jobs carry their routed lane through the real order trace', () => {
  it('a: ready.tsv routes the queued job to the held lane and the order reports BLOCKED naming it', async () => {
    const { parent, root } = await makeRoot({ ready: HELD_LANE });
    try {
      const [trace, lanes] = await Promise.all([
        readOrderTrace({ runsDir: root, now: () => NOW_MS }),
        readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) }),
      ]);
      expect(lanes.sourceState).toBe('healthy');
      expect(trace.sources.queue).toBe('healthy');
      const order = trace.orders.find((o) => o.key === ORDER_KEY)!;
      const job = order.jobs.find((j) => j.id === JOB_A);
      expect(job).toEqual({ id: JOB_A, lane: HELD_LANE, state: 'queued', url: null });
      const classification = classifyOrder(order, trace.generatedAt, NOW_ISO, undefined, lanes);
      expect(classification.state).toBe('BLOCKED');
      expect(heldLaneBlocker(order, lanes)?.dependency).toBe(`lane ${HELD_LANE} held until ${HELD_UNTIL}`);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('b: without ready.tsv the queued job keeps lane: null, reports no blocker and sources.queue is missing', async () => {
    const { parent, root } = await makeRoot({ ready: null });
    try {
      const [trace, lanes] = await Promise.all([
        readOrderTrace({ runsDir: root, now: () => NOW_MS }),
        readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) }),
      ]);
      expect(trace.sources.queue).toBe('missing');
      const order = trace.orders.find((o) => o.key === ORDER_KEY)!;
      const job = order.jobs.find((j) => j.id === JOB_A);
      expect(job).toEqual({ id: JOB_A, lane: null, state: 'queued', url: null });
      expect(classifyOrder(order, trace.generatedAt, NOW_ISO, undefined, lanes).state).not.toBe('BLOCKED');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('c: a .launch marker stays authoritative over the ready.tsv row', async () => {
    const { parent, root } = await makeRoot({ ready: HELD_LANE, launch: LAUNCHED_LANE });
    try {
      const trace = await readOrderTrace({ runsDir: root, now: () => NOW_MS });
      const job = trace.orders.find((o) => o.key === ORDER_KEY)!.jobs.find((j) => j.id === JOB_A);
      expect(job).toEqual({ id: JOB_A, lane: LAUNCHED_LANE, state: 'launched', url: null });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('d: a PARKED.<lane> dotted pool strips to the lane id', () => {
    const lanes = queuedLanesFromText([
      'RQ-PHX-FAKED368\tPARKED.devin\ttier\trepo',
      'RQ-PHX-FAKEL368\tphantom\tPARKED.devin\twork\t/fake/prompt',
      'id\tstatus\tpool',
      'RQ-PHX-FAKEH368\tREADY\tcodex-personal',
      '',
    ].join('\n'));
    expect(lanes.get('RQ-PHX-FAKED368')).toBe('devin');
    expect(lanes.get('RQ-PHX-FAKEL368')).toBe('devin');
    expect(lanes.get('RQ-PHX-FAKEH368')).toBe('codex-personal');
  });

  it('e: fleet order-state --json reports BLOCKED with the blocked-on dependency through the real readers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parent, root } = await makeRoot({ ready: HELD_LANE });
    try {
      const deps = {
        read: (o?: Parameters<typeof readOrderTrace>[0]) => readOrderTrace({ ...(o ?? {}), runsDir: root }),
        now: () => NOW_MS,
        live: () => listLiveWorkers({ runPs: async () => PS_IDLE, now: () => NOW_MS }),
        lanes: () => readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) }),
      };
      expect(await cmdFleetOrderState(['--json'], deps)).toBe(0);
      const jsonText = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(jsonText).toContain('"state":"BLOCKED"');
      const body = JSON.parse(jsonText) as { orders: Array<{ key: string; state: string; blocker: string | null }> };
      const order = body.orders.find((o) => o.key === ORDER_KEY)!;
      expect(order.state).toBe('BLOCKED');
      expect(order.blocker).toBe(`lane ${HELD_LANE} held until ${HELD_UNTIL}`);
      log.mockClear();

      expect(await cmdFleetOrderState([], deps)).toBe(0);
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain(`blocked-on=lane ${HELD_LANE} held until ${HELD_UNTIL}`);
      expect(text).not.toContain('fake-account');
      expect(text).not.toContain('fake-operator');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
