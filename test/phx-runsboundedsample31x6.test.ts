import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LeaderJournalV1 } from '../src/core/fleet/leader-journal.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';

const runs: FleetRunsDirState = {
  v: 1, generatedAt: 'fake-time', runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: ['a', 'b'].map(lane => ({ lane, running: 1, target: 2, floor: null, ceiling: null, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null })),
  claimed: [], publishesLastHour: [], events: [], drop: { pending: [], done: 2 },
};
const journal: LeaderJournalV1 = {
  v: 1, generatedAt: 'fake-time', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
  passes: [], ingest: [], ingested: [], rejectedLastHour: 0,
};
const parked: FleetQueueV1 = {
  v: 1, generatedAt: 'fake-time', sources: { ready: 'healthy', skips: 'healthy' },
  total: 2, ready: 1, parked: 1, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'a', ready: 1, parked: 0 }, { lane: 'b', ready: 0, parked: 1 }], groups: [], skips: [],
};
const fixtures = { runs, journal, parked };
const readers = () => ({ runs: vi.fn(async () => runs), journal: vi.fn(async () => journal), parked: vi.fn(async () => parked) });
let output: string[];
beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('bounded fleet watches', () => {
  it.each(['runs', 'journal', 'parked'] as const)('%s emits two successful JSONL snapshots, retrying without overlap', async verb => {
    const deps = readers();
    let active = 0;
    let attempts = 0;
    const read = vi.fn(async () => {
      expect(active++).toBe(0);
      try {
        await Promise.resolve();
        if (++attempts === 2) throw new Error('fake private detail');
        return fixtures[verb];
      } finally { active--; }
    });
    // Each fixture is selected by the same verb as the corresponding reader.
    const selected = { ...deps, [verb]: read };
    const wait = vi.fn(async (ms: number) => { expect(ms).toBe(1000); expect(active).toBe(0); });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const args = ['--watch', '--json', '--interval-ms', '1000', '--max-samples', '2', ...(verb === 'journal' ? [] : ['--lane', 'a'])];
    expect(await cmdFleetRunsRead(verb, args, selected, { signal: controller.signal, wait })).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(output).toHaveLength(3);
    const [first, failure, second] = output.map(line => JSON.parse(line));
    expect(failure).toEqual({ error: `fleet ${verb} unavailable` });
    expect(output.join('\n')).not.toContain('fake private detail');
    for (const sample of [first, second]) {
      expect(sample).toMatchObject({ v: 1, generatedAt: 'fake-time', sources: fixtures[verb].sources });
      if (verb === 'runs') {
        expect(sample.lanes.map((row: { lane: string }) => row.lane)).toEqual(['a']);
        expect(sample.laneFilter).toMatchObject({ lane: 'a', global: expect.arrayContaining(['sources', 'drop.done']), omitted: ['events'] });
      }
      if (verb === 'parked') {
        expect(sample.byLane).toEqual([{ lane: 'a', ready: 1, parked: 0 }]);
        expect(sample).toMatchObject({ total: 2, laneFilter: { lane: 'a', global: expect.arrayContaining(['sources', 'total']), omitted: ['skips'] } });
      }
    }
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s aborts before reaching its bound and cleans up listeners', async verb => {
    const deps = readers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const wait = vi.fn(async () => { controller.abort(); });
    expect(await cmdFleetRunsRead(verb, ['--watch', '--json', '--max-samples', '2'], deps, { signal: controller.signal, wait })).toBe(0);
    expect(deps[verb]).toHaveBeenCalledOnce();
    expect(output.map(line => JSON.parse(line))).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s validates the bound and requires watch before reading', async verb => {
    const deps = readers();
    const invalid = [
      ['--max-samples', '1'], ['--watch', '--max-samples'], ['--watch', '--max-samples', '0'],
      ['--watch', '--max-samples', '10001'], ['--watch', '--max-samples', '-1'],
      ['--watch', '--max-samples', '1.5'], ['--watch', '--max-samples', '1e2'],
      ['--watch', '--max-samples', ''], ['--watch', '--max-samples', '1', '--max-samples', '2'],
      ['--help', '--max-samples', '1'],
    ];
    for (const args of invalid) expect(await cmdFleetRunsRead(verb, args, deps)).toBe(2);
    expect(deps[verb]).not.toHaveBeenCalled();
    expect(await cmdFleetRunsRead(verb, ['--help'], deps)).toBe(0);
    expect(output.at(-1)).toContain('--max-samples <1..10000>');
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s accepts both bounds and stops immediately at one', async verb => {
    const deps = readers();
    const wait = vi.fn(async () => {});
    expect(await cmdFleetRunsRead(verb, ['--watch', '--json', '--max-samples', '1'], deps, { wait })).toBe(0);
    expect(deps[verb]).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(output.map(line => JSON.parse(line))).toHaveLength(1);
    output.length = 0;
    const controller = new AbortController();
    expect(await cmdFleetRunsRead(verb, ['--watch', '--max-samples', '10000'], deps, { signal: controller.signal, wait: async () => controller.abort() })).toBe(0);
    expect(output).toHaveLength(1);
  });
});
