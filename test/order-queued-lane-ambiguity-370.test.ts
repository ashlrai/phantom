/** RQ-PHX-QUEUEAMBIGUITY370: contradictory ready.tsv rows for one job must
 * not fabricate a specific order blocker. queuedLanesFromText used to let
 * last-row-wins pick a lane, so a job routed to both a held lane and an
 * unheld lane could report BLOCKED on whichever row happened to be last.
 * Now a job whose rows disagree drops its lane for the whole snapshot
 * (tombstoned against later duplicates); identical repeats and dotted/
 * ordinary spellings of the same lane still resolve.
 *
 * Fixture = a real runs root in the shapes the readers consume, same as
 * order-queued-lane-368.test.ts: leader/MASON-INBOX.md
 * `## <ET> (...) PRIORITY` entries, queue/prompts <id>.md bodies citing
 * `Serves Mason's <Mon D HH:MM> order.`, a queue/ready.tsv legacy
 * five-column row set, an optional <id>.launch marker, an empty
 * metrics/jobs.jsonl and queue/slots.json in the dispatcher's own shape.
 * Every path, lane row and timestamp is fake; the temp root is removed in
 * finally. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import { classifyOrder } from '../src/core/fleet/order-work-state.js';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { queuedLanesFromText } from '../src/core/fleet/order-queued-lanes.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = '2026-11-14T12:00:00.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const ORDER_KEY = '11-14 04:30';
const JOB_A = 'RQ-PHX-FAKEA370';
const JOB_B = 'RQ-PHX-FAKEB370';
const HELD_LANE = 'codex-personal';
const UNHELD_LANE = 'devin';

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
  [UNHELD_LANE]: { target: 6, floor: 0, ceiling: 10, last_change: Math.floor(NOW_MS / 1000) - 600 },
  hard_cap: 10,
  last_change_by: 'dispatchd',
}, null, 1)}\n`;

const PS_IDLE = '   100  2-01:02:03 /sbin/launchd\n   200     12:34 /usr/libexec/rapportd\n';

afterEach(() => vi.restoreAllMocks());

/** One real runs root: the inbox order, citing prompts for JOB_A and JOB_B,
 * slots.json holding HELD_LANE until HELD_UNTIL, an empty metrics ledger
 * and — unless `readyRows` is null — ready.tsv rows routing JOB_A through
 * each listed lane spelling plus one clean JOB_B row (UNHELD_LANE unless
 * `jobBLane` overrides, null to omit). */
async function buildRunsRoot(
  root: string,
  opts: { readyRows: string[] | null; launch?: string; jobBLane?: string | null },
): Promise<void> {
  await mkdir(join(root, 'leader'), { recursive: true });
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'), INBOX);
  await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
  const promptA = join(root, 'queue', 'prompts', `${JOB_A}.md`);
  await writeFile(promptA, CITATION);
  const jobBLane = opts.jobBLane === undefined ? UNHELD_LANE : opts.jobBLane;
  let promptB: string | null = null;
  if (jobBLane !== null) {
    promptB = join(root, 'queue', 'prompts', `${JOB_B}.md`);
    await writeFile(promptB, CITATION);
  }
  if (opts.readyRows !== null) {
    const lines = opts.readyRows.map((lane) => `${JOB_A}\tphantom\t${lane}\twork\t${promptA}`);
    if (promptB !== null && jobBLane !== null) lines.push(`${JOB_B}\tphantom\t${jobBLane}\twork\t${promptB}`);
    await writeFile(join(root, 'queue', 'ready.tsv'), `${lines.join('\n')}\n`);
  }
  if (opts.launch !== undefined) {
    await writeFile(join(root, `${JOB_A}.launch`), `launched ${JOB_A} ${opts.launch} pid 4201 base fakebase`);
  }
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), '');
  await writeFile(join(root, 'queue', 'slots.json'), slots());
}

async function makeRoot(opts: { readyRows: string[] | null; launch?: string; jobBLane?: string | null }): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'order-queued-lane-ambiguity-370-'));
  const root = join(parent, 'runs');
  await buildRunsRoot(root, opts);
  return { parent, root };
}

async function traceAndClassify(root: string) {
  const [trace, lanes] = await Promise.all([
    readOrderTrace({ runsDir: root, now: () => NOW_MS }),
    readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) }),
  ]);
  expect(lanes.sourceState).toBe('healthy');
  const order = trace.orders.find((o) => o.key === ORDER_KEY)!;
  return { trace, order, classification: classifyOrder(order, trace.generatedAt, NOW_ISO, undefined, lanes) };
}

describe('contradictory ready.tsv rows drop the job lane instead of fabricating a blocker', () => {
  it('a: held-then-unheld and unheld-then-held both leave the queued job lane null and never BLOCKED', async () => {
    for (const readyRows of [
      [HELD_LANE, UNHELD_LANE],
      [UNHELD_LANE, HELD_LANE],
    ]) {
      const { parent, root } = await makeRoot({ readyRows });
      try {
        const { trace, order, classification } = await traceAndClassify(root);
        expect(trace.sources.queue).toBe('healthy');
        const jobA = order.jobs.find((j) => j.id === JOB_A);
        expect(jobA).toEqual({ id: JOB_A, lane: null, state: 'queued', url: null });
        const jobB = order.jobs.find((j) => j.id === JOB_B);
        expect(jobB).toEqual({ id: JOB_B, lane: UNHELD_LANE, state: 'queued', url: null });
        expect(classification.state).not.toBe('BLOCKED');
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  });

  it('b: identical duplicate rows keep the lane and still report BLOCKED on the held lane', async () => {
    const { parent, root } = await makeRoot({ readyRows: [HELD_LANE, HELD_LANE], jobBLane: HELD_LANE });
    try {
      const { order, classification } = await traceAndClassify(root);
      const jobA = order.jobs.find((j) => j.id === JOB_A);
      expect(jobA).toEqual({ id: JOB_A, lane: HELD_LANE, state: 'queued', url: null });
      expect(classification.state).toBe('BLOCKED');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('c: a third row repeating an earlier lane does not erase the ambiguity', async () => {
    const { parent, root } = await makeRoot({ readyRows: [HELD_LANE, UNHELD_LANE, HELD_LANE] });
    try {
      const { order, classification } = await traceAndClassify(root);
      const jobA = order.jobs.find((j) => j.id === JOB_A);
      expect(jobA).toEqual({ id: JOB_A, lane: null, state: 'queued', url: null });
      expect(classification.state).not.toBe('BLOCKED');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('d: dotted and ordinary spellings of the same lane agree and stay blockable', async () => {
    const lanes = queuedLanesFromText([
      `${JOB_A}\tphantom\tPARKED.${HELD_LANE}\twork\t/fake/prompt`,
      `${JOB_A}\tphantom\t${HELD_LANE}\twork\t/fake/prompt`,
      `${JOB_B}\tphantom\tPARKED.${UNHELD_LANE}\twork\t/fake/prompt`,
      `${JOB_B}\tphantom\t${UNHELD_LANE}\twork\t/fake/prompt`,
      '',
    ].join('\n'));
    expect(lanes.get(JOB_A)).toBe(HELD_LANE);
    expect(lanes.get(JOB_B)).toBe(UNHELD_LANE);

    const { parent, root } = await makeRoot({ readyRows: [`PARKED.${HELD_LANE}`, HELD_LANE], jobBLane: HELD_LANE });
    try {
      const { order, classification } = await traceAndClassify(root);
      const jobA = order.jobs.find((j) => j.id === JOB_A);
      expect(jobA).toEqual({ id: JOB_A, lane: HELD_LANE, state: 'queued', url: null });
      expect(classification.state).toBe('BLOCKED');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('e: a real .launch marker still takes precedence over ambiguous ready hints', async () => {
    const { parent, root } = await makeRoot({ readyRows: [HELD_LANE, UNHELD_LANE], launch: UNHELD_LANE });
    try {
      const trace = await readOrderTrace({ runsDir: root, now: () => NOW_MS });
      const job = trace.orders.find((o) => o.key === ORDER_KEY)!.jobs.find((j) => j.id === JOB_A);
      expect(job).toEqual({ id: JOB_A, lane: UNHELD_LANE, state: 'launched', url: null });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('f: fleet order-state --json stays clean — no fixture paths or raw queue rows in public output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parent, root } = await makeRoot({ readyRows: [HELD_LANE, UNHELD_LANE] });
    try {
      const deps = {
        read: (o?: Parameters<typeof readOrderTrace>[0]) => readOrderTrace({ ...(o ?? {}), runsDir: root }),
        now: () => NOW_MS,
        live: () => listLiveWorkers({ runPs: async () => PS_IDLE, now: () => NOW_MS }),
        lanes: () => readLaneTargets({ runsDir: root, now: () => new Date(NOW_MS) }),
      };
      expect(await cmdFleetOrderState(['--json'], deps)).toBe(0);
      const jsonText = log.mock.calls.map((c) => String(c[0])).join('\n');
      const body = JSON.parse(jsonText) as { orders: Array<{ key: string; state: string }> };
      const order = body.orders.find((o) => o.key === ORDER_KEY)!;
      expect(order.state).not.toBe('BLOCKED');
      log.mockClear();

      expect(await cmdFleetOrderState([], deps)).toBe(0);
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).not.toContain(parent);
      expect(text).not.toContain(root);
      expect(text).not.toContain('ready.tsv');
      expect(text).not.toContain('prompts');
      expect(text).not.toContain('fake-account');
      expect(text).not.toContain('fake-operator');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
