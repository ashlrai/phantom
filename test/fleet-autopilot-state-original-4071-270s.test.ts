/**
 * Recovery coverage for the read-only fleet autopilot state slice of open
 * PR #4071 (RQ-SWE3-AUTOPILOT-1). Scenario mapping vs the original
 * test/fleet-autopilot.test.ts is recorded in BRIDGE_NOTES.md; the pure
 * planner, lane holds, writes, enqueue and metDeps projection are out of scope.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetAutopilotState, type FleetAutopilotState } from '../src/core/fleet/autopilot-state.js';
import { cmdFleetAutopilotState, formatAutopilotState } from '../src/cli/fleet-autopilot-state.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { FleetAdmissionReport } from '../src/cli/fleet-admission.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const scratch = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const admission = (lanes: FleetAdmissionReport['lanes'], cap = 18, running = 18): FleetAdmissionReport => ({
  schema: 'fleet.admission.v1', readOnly: true, status: 'ok',
  global: { cap, running, load1: 1, admit_reason: null, at_cap: running >= cap },
  lanes,
});

const queueView = (patch: Partial<FleetQueueV1> = {}): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-11-07T00:00:00.000Z',
  sources: { ready: 'healthy', skips: 'healthy' },
  total: 0, ready: 0, parked: 0, malformed: 0,
  byLane: [], groups: [], skips: [], skipsLast24h: 0,
  ...patch,
});

const slotsView = (lanes: LaneTargetsV1['lanes'] = [], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 => ({
  v: 1, generatedAt: '2026-11-07T00:00:00.000Z', sourceState, lanes,
});

const slotLane = (lane: string, target: number): LaneTargetsV1['lanes'][number] => ({
  lane, target, floor: 0, ceiling: 8, held: false, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null,
});

const state = (patch: Partial<FleetAutopilotState> = {}): FleetAutopilotState => ({
  generatedAt: '2026-11-07T00:00:00.000Z',
  sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' },
  admission: admission([]), queue: queueView(), slots: slotsView(), rebase: null,
  ...patch,
});

// ---------------------------------------------------------------------------
// readFleetAutopilotState — injected readers (ports of the original cases)
// ---------------------------------------------------------------------------

describe('readFleetAutopilotState', () => {
  it('assembles all four sources and maps the rebase projection', async () => {
    const dir = await scratch('fleet-autopilot-state-');
    const slots = slotsView([slotLane('devin', 2)]);
    const queue = queueView({ byLane: [{ lane: 'devin', ready: 1, parked: 0 }] });
    const rebase = vi.fn(async () => ({
      v: 1 as const, generatedAt: '', queueSource: 'healthy' as const,
      repos: [{ repo: 'ashlrai/phantom', source: 'ok' as const, summary: {
        conflicting: 2, ageSeconds: { oldest: 10, median: 5, unknown: 0 },
        coverage: { currentHead: 1, staleHeadOnly: 0, unknownHead: 0, uncovered: 1 },
      } }],
    }));
    const assembled = await readFleetAutopilotState({
      runsDir: dir,
      repos: ['ashlrai/phantom'],
      statusText: async () => JSON.stringify({
        admission: { cap: 4, running: 2, load1: 1, reason: null },
        lanes: { devin: { running: 1, target: 2, queued: 1, held: false } },
      }),
      queue: async () => queue,
      slots: async () => slots,
      rebase,
      now: () => new Date('2026-11-07T00:00:00Z'),
    });
    expect(assembled.generatedAt).toBe('2026-11-07T00:00:00.000Z');
    expect(assembled.sources).toEqual({ status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'ok' });
    expect(assembled.admission?.lanes[0]).toMatchObject({ lane: 'devin', running: 1, target: 2 });
    expect(assembled.queue).toBe(queue);
    expect(assembled.slots).toBe(slots);
    expect(assembled.rebase).toEqual([{ repo: 'ashlrai/phantom', source: 'ok', conflicting: 2, uncovered: 1, staleHeadOnly: 0 }]);
    expect(rebase).toHaveBeenCalledWith(['ashlrai/phantom'], dir, new Date('2026-11-07T00:00:00Z'));
  });

  it('reports missing status and skips rebase reads without repos', async () => {
    const dir = await scratch('fleet-autopilot-state-');
    const rebase = vi.fn();
    const assembled = await readFleetAutopilotState({ runsDir: dir, rebase });
    expect(assembled.sources.status).toBe('missing');
    expect(assembled.sources.queue).toBe('missing');
    expect(assembled.sources.slots).toBe('missing');
    expect(assembled.sources.rebase).toBe('unconfigured');
    expect(assembled.rebase).toBeNull();
    expect(rebase).not.toHaveBeenCalled();
  });

  it('marks the rebase source partial when one repo read fails', async () => {
    const dir = await scratch('fleet-autopilot-state-');
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
    expect(assembled.rebase?.[1]).toMatchObject({ repo: 'ashlrai/other', source: 'unavailable', uncovered: null, staleHeadOnly: null });
  });

  it('takes the queue source from sources.ready, never the skip tail', async () => {
    const dir = await scratch('fleet-autopilot-state-');
    const readyOnly = await readFleetAutopilotState({
      runsDir: dir,
      statusText: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
      queue: async () => queueView({ sources: { ready: 'healthy', skips: 'missing' } }),
      slots: async () => slotsView(),
    });
    expect(readyOnly.sources.queue).toBe('healthy');
    const degraded = await readFleetAutopilotState({
      runsDir: dir,
      queue: async () => queueView({ sources: { ready: 'degraded', skips: 'healthy' } }),
      slots: async () => slotsView(),
    });
    expect(degraded.sources.queue).toBe('degraded');
  });

  it('nulls only the queue slice when the queue reader rejects', async () => {
    const dir = await scratch('fleet-autopilot-state-');
    const assembled = await readFleetAutopilotState({
      runsDir: dir,
      queue: async () => { throw new Error('boom'); },
      slots: async () => slotsView([slotLane('devin', 2)]),
    });
    expect(assembled.sources.queue).toBe('degraded');
    expect(assembled.queue).toBeNull();
    expect(assembled.slots?.lanes[0]?.lane).toBe('devin');
    expect(assembled.sources.slots).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// readFleetAutopilotState — real readers over a fixture runs dir
// ---------------------------------------------------------------------------

async function seedRunsDir(): Promise<string> {
  const dir = await scratch('fleet-autopilot-state-e2e-');
  await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
  await mkdir(join(dir, 'metrics'), { recursive: true });
  const prompt = join(dir, 'queue', 'prompts', 'stale.md');
  await writeFile(prompt, 'DEPENDENCY GATE: RQ-OPEN\n\nno merge without Security pin\n');
  await writeFile(join(dir, 'queue', 'ready.tsv'), [
    'READY\tRQ-NEW\tdevin\twork\tphantom\tprompts/x.md',
    `PARKED-DEP.devin\tRQ-STALE\tdevin\twork\tphantom\t${prompt}`,
  ].join('\n'));
  await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
    `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DONE' })}\n`);
  await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({
    admission: { cap: 4, running: 2, load1: 1, reason: null },
    lanes: { devin: { running: 1, target: 2, queued: 2, held: false } },
  }));
  await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify({
    devin: { target: 2, floor: 0, ceiling: 4 },
  }));
  return dir;
}

describe('readFleetAutopilotState on a fixture runs dir', () => {
  it('assembles healthy admission, queue and slots with unmet dep rows', async () => {
    const dir = await seedRunsDir();
    const assembled = await readFleetAutopilotState({ runsDir: dir, now: () => new Date('2026-11-07T00:00:00Z') });
    expect(assembled.generatedAt).toBe('2026-11-07T00:00:00.000Z');
    expect(assembled.sources).toEqual({ status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' });
    expect(assembled.admission?.lanes[0]).toMatchObject({ lane: 'devin', running: 1, target: 2, queued: 2 });
    expect(assembled.queue?.ready).toBe(1);
    expect(assembled.queue?.byLane.find((row) => row.lane === 'devin')).toMatchObject({ ready: 1, parked: 1 });
    expect(assembled.queue?.unmetDeps).toEqual([{ job: 'RQ-STALE', lane: 'devin', unmet: ['RQ-OPEN'] }]);
    expect(assembled.slots?.lanes[0]).toMatchObject({ lane: 'devin', target: 2 });
    // The original depDetail/metDeps projection is not part of this slice:
    // today's readFleetQueue reports unmet gates only and invents no met facts.
    expect(assembled.queue && 'metDeps' in assembled.queue).toBe(false);
    expect(JSON.stringify(assembled)).not.toContain('no merge without Security pin');
  });

  it('keeps healthy siblings when status.json is malformed and ready.tsv is absent', async () => {
    const dir = await scratch('fleet-autopilot-state-partial-');
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue', 'status.json'), '{not json');
    await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify({
      devin: { target: 1, floor: 0, ceiling: 2 },
    }));
    const assembled = await readFleetAutopilotState({ runsDir: dir });
    expect(assembled.sources).toEqual({ status: 'degraded', queue: 'missing', slots: 'healthy', rebase: 'unconfigured' });
    expect(assembled.admission).toBeNull();
    expect(assembled.queue?.ready).toBe(0);
    expect(assembled.slots?.lanes[0]?.lane).toBe('devin');
  });
});

// ---------------------------------------------------------------------------
// cmdFleetAutopilotState — CLI surface
// ---------------------------------------------------------------------------

describe('cmdFleetAutopilotState', () => {
  const loadState = (s: FleetAutopilotState) => vi.fn(async () => s);

  it('prints the state as JSON with --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const load = loadState(state());
    expect(await cmdFleetAutopilotState(['--json', '--runs-dir', '/tmp/x'], { loadState: load })).toBe(0);
    expect(load).toHaveBeenCalledWith({ runsDir: '/tmp/x', repos: [] });
    const printed = JSON.parse(log.mock.calls[0]![0] as string);
    expect(printed.sources).toEqual({ status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' });
    expect(printed.queue.ready).toBe(0);
  });

  it('prints a concise per-source summary without --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const load = loadState(state({
      queue: queueView({ ready: 3, byLane: [{ lane: 'devin', ready: 3, parked: 0 }] }),
      rebase: [{ repo: 'ashlrai/phantom', source: 'ok', conflicting: 2, uncovered: 1, staleHeadOnly: 0 }],
      sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'ok' },
    }));
    expect(await cmdFleetAutopilotState([], { loadState: load })).toBe(0);
    const text = log.mock.calls[0]![0] as string;
    expect(text).toContain('fleet autopilot-state');
    expect(text).toContain('status: healthy');
    expect(text).toContain('queue: healthy (ready 3, parked 0');
    expect(text).toContain('rebase: ok (1 repos, 1 conflicting PRs due a rebase)');
    expect(formatAutopilotState(state())).toContain('rebase: unconfigured');
  });

  it('passes repeated --repo values through in order', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const load = loadState(state());
    expect(await cmdFleetAutopilotState(['--json', '--repo', 'ashlrai/phantom', '--repo', 'ashlrai/other'], { loadState: load })).toBe(0);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ repos: ['ashlrai/phantom', 'ashlrai/other'] }));
  });

  it.each([
    ['--bogus'],
    ['--runs-dir', 'relative/path'],
    ['--repo', 'not-a-repo'],
    ['--repo', 'a/b', '--repo', 'c/b'],
    ['--repo'],
    ['--json', '--json'],
  ])('rejects invalid arguments %j before any IO', async (...args: string[]) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.fn();
    expect(await cmdFleetAutopilotState(args, { loadState: load })).toBe(2);
    expect(error).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('prints usage on --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetAutopilotState(['--help'])).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('fleet autopilot-state');
  });

  it('exits nonzero with a diagnostic when no local source is readable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = state({
      sources: { status: 'missing', queue: 'missing', slots: 'missing', rebase: 'unconfigured' },
      admission: null, queue: null, slots: null,
    });
    expect(await cmdFleetAutopilotState(['--json'], { loadState: loadState(unreadable) })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no usable local source'));
  });

  it('resolves through the fleet subcommand convention', async () => {
    expect(resolveFleetSubcommand('autopilot-state')).toEqual({
      module: './fleet-autopilot-state.js', exportName: 'cmdFleetAutopilotState',
    });
    const mod = await import('../src/cli/fleet-autopilot-state.js');
    expect(typeof mod.cmdFleetAutopilotState).toBe('function');
  });
});
