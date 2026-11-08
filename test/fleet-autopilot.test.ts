import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_AUTOPILOT_SCHEMA,
  autopilotLanes,
  planFleetAutopilot,
  readFleetAutopilotState,
  type FleetAutopilotState,
} from '../src/core/fleet/autopilot.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { cmdFleetAutopilot, formatAutopilotReport } from '../src/cli/fleet-autopilot.js';
import type { FleetAdmissionReport } from '../src/cli/fleet-admission.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const admissionLane = (
  lane: string, running: number, target: number, queued: number, held = false,
): FleetAdmissionReport['lanes'][number] => ({ lane, running, target, queued, held, reason: 'ok', status: 'ok' });

const admission = (
  lanes: FleetAdmissionReport['lanes'], cap = 18, running = 18, atCap?: boolean,
): FleetAdmissionReport => ({
  schema: 'fleet.admission.v1', readOnly: true, status: 'ok',
  global: { cap, running, load1: 1, admit_reason: atCap === undefined ? null : (atCap ? 'at_cap: global running reached the cap' : 'ok'), at_cap: atCap ?? running >= cap },
  lanes,
});

const queueView = (patch: Partial<FleetQueueV1> = {}): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-11-07T00:00:00.000Z',
  sources: { ready: 'healthy', skips: 'healthy' },
  total: 0, ready: 0, parked: 0, malformed: 0,
  byLane: [], nextUp: [], groups: [], unmetDeps: [], metDeps: [], skips: [], skipsLast24h: 0,
  ...patch,
});

const slotsView = (lanes: LaneTargetsV1['lanes'] = [], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 => ({
  v: 1, generatedAt: '2026-11-07T00:00:00.000Z', sourceState, lanes,
});

const slotLane = (lane: string, target: number, held = false): LaneTargetsV1['lanes'][number] => ({
  lane, target, floor: 0, ceiling: 8, held, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null,
});

const state = (patch: Partial<FleetAutopilotState> = {}): FleetAutopilotState => ({
  generatedAt: '2026-11-07T00:00:00.000Z',
  sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' },
  admission: admission([]), queue: queueView(), slots: slotsView(), rebase: null,
  ...patch,
});

// ---------------------------------------------------------------------------
// planFleetAutopilot — pure planner
// ---------------------------------------------------------------------------

describe('planFleetAutopilot', () => {
  it('reports fleet-healthy when every lane is at target', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 2, 2, 3), admissionLane('codex-local', 1, 1, 0)]),
      queue: queueView({ byLane: [{ lane: 'devin', ready: 3, parked: 0 }] }),
      slots: slotsView([slotLane('devin', 2), slotLane('codex-local', 1)]),
    }));
    expect(report.schema).toBe(FLEET_AUTOPILOT_SCHEMA);
    expect(report.readOnly).toBe(true);
    expect(report.status).toBe('ok');
    expect(report.gaps).toEqual([]);
    expect(report.topGap).toBeNull();
    expect(report.action).toMatchObject({ kind: 'no-op', reason: 'fleet-healthy' });
    expect(report.lanes.find((l) => l.lane === 'devin')).toMatchObject({ running: 2, target: 2, ready: 3, utilization: 1, freeSlots: 0 });
  });

  it('proposes hold-lane for a starved lane at the cap with an over-deep sibling', () => {
    const report = planFleetAutopilot(state({
      admission: admission([
        admissionLane('devin', 0, 2, 6),        // starved: 0 of 2, 6 queued
        admissionLane('codex-local', 3, 2, 12), // running 3 over target 2, deep queue
      ], 3, 3),
      queue: queueView({ byLane: [{ lane: 'devin', ready: 6, parked: 0 }, { lane: 'codex-local', ready: 12, parked: 0 }] }),
    }));
    expect(report.topGap?.kind).toBe('starved-lane');
    expect(report.topGap?.lane).toBe('devin');
    expect(report.action).toMatchObject({ kind: 'hold-lane', lane: 'codex-local' });
  });

  it('answers capacity-bound when the starved lane has no holdable sibling', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 0, 2, 6), admissionLane('codex-local', 2, 2, 1)], 2, 2),
      queue: queueView({ byLane: [{ lane: 'devin', ready: 6, parked: 0 }, { lane: 'codex-local', ready: 1, parked: 0 }] }),
    }));
    expect(report.topGap?.kind).toBe('starved-lane');
    expect(report.action).toMatchObject({ kind: 'no-op', reason: 'capacity-bound' });
  });

  it('answers dispatch-stall when a lane is starved while the fleet is under the cap', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 0, 2, 4), admissionLane('codex-local', 2, 2, 2)], 18, 2),
      queue: queueView({ byLane: [{ lane: 'devin', ready: 4, parked: 0 }, { lane: 'codex-local', ready: 2, parked: 0 }] }),
    }));
    expect(report.topGap?.kind).toBe('starved-lane');
    expect(report.action).toMatchObject({ kind: 'no-op', reason: 'dispatch-stall' });
  });

  it('proposes an unpark sweep for stale parked deps whose gates all merged', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 2, 2, 0)]),
      queue: queueView({
        byLane: [{ lane: 'devin', ready: 0, parked: 2 }],
        metDeps: [{ job: 'RQ-OLD-1', lane: 'devin', gates: ['RQ-A'] }, { job: 'RQ-OLD-2', lane: 'devin', gates: ['RQ-B'] }],
      }),
    }));
    expect(report.topGap?.kind).toBe('stale-parked-deps');
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'unpark', count: 2, lane: 'devin' });
  });

  it('proposes restock for a lane with free slots and an empty ready queue', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 0, 3, 0)], 18, 0),
      queue: queueView({ byLane: [] }),
      slots: slotsView([slotLane('devin', 3)]),
    }));
    expect(report.topGap?.kind).toBe('missing-restock');
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'restock', count: 3, lane: 'devin' });
  });

  it('proposes rebase jobs for uncovered conflicting PRs, capped', () => {
    const report = planFleetAutopilot(state({
      sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'ok' },
      rebase: [{ repo: 'ashlrai/phantom', source: 'ok', conflicting: 30, uncovered: 22, staleHeadOnly: 3 }],
    }));
    expect(report.topGap?.kind).toBe('uncovered-conflicts');
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'rebase', count: 20, lane: null, repos: ['ashlrai/phantom'] });
  });

  it('ranks uncovered conflicts above a starved lane', () => {
    const report = planFleetAutopilot(state({
      sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'ok' },
      admission: admission([admissionLane('devin', 0, 2, 6)], 3, 3),
      queue: queueView({ byLane: [{ lane: 'devin', ready: 6, parked: 0 }] }),
      rebase: [{ repo: 'ashlrai/phantom', source: 'ok', conflicting: 1, uncovered: 1, staleHeadOnly: 0 }],
    }));
    expect(report.gaps.map((g) => g.kind)).toEqual(['uncovered-conflicts', 'starved-lane']);
    expect(report.action.kind).toBe('enqueue');
    expect(report.action).toMatchObject({ type: 'rebase' });
  });

  it('never flags held lanes for starvation or restock', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 0, 2, 5, true)]),
      queue: queueView({ byLane: [] }),
    }));
    expect(report.gaps).toEqual([]);
    expect(report.action).toMatchObject({ kind: 'no-op', reason: 'fleet-healthy' });
  });

  it('does not flag a lane whose only queued rows are parked (unmet deps are waiting, not starvation)', () => {
    const report = planFleetAutopilot(state({
      admission: admission([admissionLane('devin', 0, 2, 1)]),
      queue: queueView({
        byLane: [{ lane: 'devin', ready: 0, parked: 1 }],
        unmetDeps: [{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-UP'] }],
      }),
    }));
    // ready = 0 with a free slot reads as missing-restock — supply, not starvation.
    expect(report.gaps.every((g) => g.kind !== 'starved-lane')).toBe(true);
    expect(report.lanes[0]).toMatchObject({ lane: 'devin', ready: 0, depWaiting: 1 });
  });

  it('answers state-unreadable when no local source is usable', () => {
    const report = planFleetAutopilot(state({
      sources: { status: 'degraded', queue: 'missing', slots: 'degraded', rebase: 'unconfigured' },
      admission: null, queue: null, slots: null,
    }));
    expect(report.status).toBe('unreadable');
    expect(report.action).toMatchObject({ kind: 'no-op', reason: 'state-unreadable' });
  });

  it('marks status degraded when a source is partial but still plans', () => {
    const report = planFleetAutopilot(state({
      sources: { status: 'healthy', queue: 'degraded', slots: 'healthy', rebase: 'unconfigured' },
      queue: queueView({ sources: { ready: 'degraded', skips: 'healthy' } }),
    }));
    expect(report.status).toBe('degraded');
    expect(report.action.kind).toBe('no-op');
  });

  it('joins a lane seen only in slots with unknown utilization and no free slots', () => {
    const [lane] = autopilotLanes(state({
      admission: admission([]),
      slots: slotsView([slotLane('devin', 3)]),
      queue: queueView(),
    }));
    expect(lane).toMatchObject({ lane: 'devin', running: null, target: 3, freeSlots: null, utilization: null });
  });
});

// ---------------------------------------------------------------------------
// readFleetAutopilotState — bounded state assembly
// ---------------------------------------------------------------------------

describe('readFleetAutopilotState', () => {
  it('assembles all four sources and maps the rebase projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-'));
    dirs.push(dir);
    const slots = slotsView([slotLane('devin', 2)]);
    const queue = queueView({ byLane: [{ lane: 'devin', ready: 1, parked: 0 }] });
    const assembled = await readFleetAutopilotState({
      runsDir: dir,
      repos: ['ashlrai/phantom'],
      statusText: async () => JSON.stringify({
        admission: { cap: 4, running: 2, load1: 1, reason: null },
        lanes: { devin: { running: 1, target: 2, queued: 1, held: false } },
      }),
      queue: async () => queue,
      slots: async () => slots,
      rebase: async () => ({
        v: 1, generatedAt: '', queueSource: 'healthy',
        repos: [{ repo: 'ashlrai/phantom', source: 'ok' as const, summary: {
          conflicting: 2,
          ageSeconds: { oldest: 10, median: 5, unknown: 0 },
          coverage: { currentHead: 1, staleHeadOnly: 0, unknownHead: 0, uncovered: 1 },
        } }],
      }),
      now: () => new Date('2026-11-07T00:00:00Z'),
    });
    expect(assembled.sources).toEqual({ status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'ok' });
    expect(assembled.admission?.lanes[0]).toMatchObject({ lane: 'devin', running: 1, target: 2 });
    expect(assembled.rebase).toEqual([{ repo: 'ashlrai/phantom', source: 'ok', conflicting: 2, uncovered: 1, staleHeadOnly: 0 }]);
  });

  it('reports missing status and skips rebase reads without --repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-'));
    dirs.push(dir);
    const rebase = vi.fn();
    const assembled = await readFleetAutopilotState({ runsDir: dir, rebase });
    expect(assembled.sources.status).toBe('missing');
    expect(assembled.sources.rebase).toBe('unconfigured');
    expect(assembled.rebase).toBeNull();
    expect(rebase).not.toHaveBeenCalled();
  });

  it('marks the rebase source partial when one repo read fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-'));
    dirs.push(dir);
    const assembled = await readFleetAutopilotState({
      runsDir: dir,
      repos: ['ashlrai/phantom', 'ashlrai/other'],
      statusText: async () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); },
      queue: async () => queueView(),
      slots: async () => slotsView(),
      rebase: async () => ({
        v: 1, generatedAt: '', queueSource: 'healthy',
        repos: [
          { repo: 'ashlrai/phantom', source: 'ok' as const, summary: { conflicting: 0, ageSeconds: { oldest: null, median: null, unknown: 0 }, coverage: { currentHead: 0, staleHeadOnly: 0, unknownHead: 0, uncovered: 0 } } },
          { repo: 'ashlrai/other', source: 'unavailable' as const, summary: null },
        ],
      }),
    });
    expect(assembled.sources.status).toBe('degraded');
    expect(assembled.sources.rebase).toBe('partial');
    expect(assembled.rebase?.[1]).toMatchObject({ repo: 'ashlrai/other', uncovered: null });
  });
});

// ---------------------------------------------------------------------------
// cmdFleetAutopilot — CLI surface
// ---------------------------------------------------------------------------

const sampleReport = planFleetAutopilot(state({
  admission: admission([admissionLane('devin', 0, 3, 0)], 18, 0),
  queue: queueView(),
}));

describe('cmdFleetAutopilot', () => {
  const loadState = (s: FleetAutopilotState) => vi.fn(async () => s);

  it('prints the plan as JSON with --once --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const load = loadState(state({
      admission: admission([admissionLane('devin', 0, 3, 0)], 18, 0),
      queue: queueView(),
    }));
    expect(await cmdFleetAutopilot(['--once', '--json', '--runs-dir', '/tmp/x'], { loadState: load })).toBe(0);
    expect(load).toHaveBeenCalledWith({ runsDir: '/tmp/x', repos: [] });
    const printed = JSON.parse(log.mock.calls[0]![0] as string);
    expect(printed.schema).toBe(FLEET_AUTOPILOT_SCHEMA);
    expect(printed.action).toMatchObject({ kind: 'enqueue', type: 'restock', count: 3, lane: 'devin' });
  });

  it('prints a human summary without --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const load = loadState(state({ admission: admission([admissionLane('devin', 2, 2, 0)]) }));
    expect(await cmdFleetAutopilot([], { loadState: load })).toBe(0);
    const text = log.mock.calls[0]![0] as string;
    expect(text).toContain('Autopilot ok');
    expect(text).toContain('devin');
    expect(text).toContain('no-op (fleet-healthy)');
    expect(formatAutopilotReport(sampleReport)).toContain('enqueue 3 restock');
  });

  it('passes repeated --repo values to the state read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const load = loadState(state());
    expect(await cmdFleetAutopilot(['--json', '--repo', 'ashlrai/phantom', '--repo', 'ashlrai/other'], { loadState: load })).toBe(0);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ repos: ['ashlrai/phantom', 'ashlrai/other'] }));
  });

  it.each([
    ['--bogus'],
    ['--runs-dir', 'relative/path'],
    ['--repo', 'not-a-repo'],
    ['--repo', 'a/b', '--repo', 'c/b'],      // duplicate repo basename
    ['--repo'],                             // missing value
    ['--json', '--json'],
    ['--once', '--once'],
  ])('rejects invalid arguments %j', async (...args: string[]) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.fn();
    expect(await cmdFleetAutopilot(args, { loadState: load })).toBe(2);
    expect(error).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('prints usage on --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetAutopilot(['--help'])).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('fleet autopilot');
  });
});

// ---------------------------------------------------------------------------
// metDeps projection + end-to-end through the real readers (fixture runs dir)
// ---------------------------------------------------------------------------

describe('readFleetQueue depDetail metDeps', () => {
  const seed = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-deps-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    return dir;
  };

  it('emits metDeps only with depDetail, alongside unmetDeps', async () => {
    const dir = await seed();
    const metPrompt = join(dir, 'queue', 'prompts', 'met.md');
    const unmetPrompt = join(dir, 'queue', 'prompts', 'unmet.md');
    await writeFile(metPrompt, 'DEPENDENCY GATE: RQ-DONE\n');
    await writeFile(unmetPrompt, 'DEPENDENCY GATE: RQ-DONE, RQ-OPEN\n');
    await writeFile(join(dir, 'queue', 'ready.tsv'), [
      `PARKED-DEP.devin\tRQ-MET\tdevin\twork\tphantom\t${metPrompt}`,
      `PARKED-DEP.devin\tRQ-UNMET\tdevin\twork\tphantom\t${unmetPrompt}`,
    ].join('\n'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DONE' })}\n`);

    const off = await readFleetQueue({ runsDir: dir });
    expect(off.metDeps).toBeUndefined();

    const on = await readFleetQueue({ runsDir: dir, depDetail: true });
    expect(on.unmetDeps).toEqual([{ job: 'RQ-UNMET', lane: 'devin', unmet: ['RQ-OPEN'] }]);
    expect(on.metDeps).toEqual([{ job: 'RQ-MET', lane: 'devin', gates: ['RQ-DONE'] }]);
  });
});

describe('fleet autopilot end-to-end on a fixture runs dir', () => {
  it('proposes an unpark sweep from real queue/status/slots files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-e2e-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    const prompt = join(dir, 'queue', 'prompts', 'stale.md');
    await writeFile(prompt, 'DEPENDENCY GATE: RQ-DONE\n\nno merge without Security pin\n');
    await writeFile(join(dir, 'queue', 'ready.tsv'),
      `PARKED-DEP.devin\tRQ-STALE\tdevin\twork\tphantom\t${prompt}\n`);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DONE' })}\n`);
    await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({
      admission: { cap: 4, running: 2, load1: 1, reason: null },
      lanes: { devin: { running: 2, target: 2, queued: 1, held: false } },
    }));
    await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify({
      devin: { target: 2, floor: 0, ceiling: 4 },
    }));

    const st = await readFleetAutopilotState({ runsDir: dir, now: () => new Date('2026-11-07T00:00:00Z') });
    expect(st.sources).toEqual({ status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' });
    const report = planFleetAutopilot(st);
    expect(report.topGap?.kind).toBe('stale-parked-deps');
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'unpark', count: 1, lane: 'devin' });
    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain('no merge without Security pin');
    expect(rendered).not.toContain(prompt);
  });

  it('proposes restock when a lane has free slots and no ready rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-e2e-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue', 'ready.tsv'),
      'READY\tRQ-NEW\tdevin\twork\tphantom\tprompts/x.md\n');
    await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({
      admission: { cap: 4, running: 1, load1: 1, reason: null },
      lanes: {
        devin: { running: 1, target: 1, queued: 1, held: false },
        'codex-local': { running: 0, target: 2, queued: 0, held: false },
      },
    }));
    const st = await readFleetAutopilotState({ runsDir: dir });
    const report = planFleetAutopilot(st);
    expect(report.topGap?.kind).toBe('missing-restock');
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'restock', count: 2, lane: 'codex-local' });
    // The starved sibling (running 1/1) is at target — no starvation gap.
    expect(report.gaps).toHaveLength(1);
  });
});
