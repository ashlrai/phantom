import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LeaderJournalV1 } from '../src/core/fleet/leader-journal.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';

const journal: LeaderJournalV1 = {
  v: 1, generatedAt: 'first', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
  passes: [], ingest: [], ingested: [], rejectedLastHour: 0,
};
const parked: FleetQueueV1 = {
  v: 1, generatedAt: 'first', sources: { ready: 'healthy', skips: 'healthy' },
  total: 3, ready: 1, parked: 2, malformed: 0, skipsLast24h: 1,
  byLane: [{ lane: 'a', ready: 0, parked: 1 }, { lane: 'b', ready: 1, parked: 1 }],
  groups: [{ lane: 'a', reason: 'HOLD', count: 1, jobs: ['A'] }, { lane: 'b', reason: 'HOLD', count: 1, jobs: ['B'] }],
  skips: [{ at: 'now', job: 'B', code: 'SKIP', reason: 'busy' }],
};
const deps = () => ({ runs: readFleetRunsDirState, journal: vi.fn(async () => journal), parked: vi.fn(async () => parked) });
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet journal and parked watch', () => {
  it.each(['journal', 'parked'] as const)('samples %s immediately, retries failures, and emits each JSONL record', async verb => {
    const controller = new AbortController();
    const readers = deps();
    const initial = verb === 'journal' ? journal : parked;
    const read = vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('private detail'))
      .mockResolvedValueOnce({ ...initial, generatedAt: 'recovered' });
    readers[verb] = read;
    let ticks = 0;
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => { if (++ticks === 3) controller.abort(); });
    const args = ['--watch', '--json', '--interval-ms', '1000', ...(verb === 'parked' ? ['--lane', 'a'] : [])];
    const command = cmdFleetRunsRead(verb, args, readers, { signal: controller.signal, wait });
    expect(read).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(await command).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(call => call[0])).toEqual([1000, 1000, 1000]);
    const [first, failure, recovered] = output.map(line => JSON.parse(line));
    expect(failure).toEqual({ error: `fleet ${verb} unavailable` });
    expect(output.join('\n')).not.toContain('private detail');
    expect(first.generatedAt).toBe('first');
    expect(recovered.generatedAt).toBe('recovered');
    if (verb === 'parked') for (const sample of [first, recovered]) {
      expect(sample).toMatchObject({ total: 3, ready: 1, parked: 2, malformed: 0, skipsLast24h: 1,
        byLane: [{ lane: 'a', ready: 0, parked: 1 }], groups: [{ lane: 'a', jobs: ['A'] }], skips: [],
        laneFilter: { lane: 'a', omitted: ['skips'] } });
      expect(sample.sources).toEqual(parked.sources);
    }
    expect(errors).toEqual([]);
  });

  it.each(['journal', 'parked'] as const)('rejects invalid %s options without reading', async verb => {
    const readers = deps();
    const invalid = [
      ['--interval-ms', '1000'], ['--watch', '--interval-ms'], ['--watch', '--interval-ms', '999'],
      ['--watch', '--interval-ms', '60001'], ['--watch', '--interval-ms', '1.5'], ['--watch', '--interval-ms', '1e3'],
      ['--watch', '--interval-ms', '1000', '--interval-ms', '2000'], ['--watch', '--watch'],
      ...(verb === 'journal' ? [['--watch', '--lane', 'a']] : []),
    ];
    for (const args of invalid) expect(await cmdFleetRunsRead(verb, args, readers)).toBe(2);
    expect(readers[verb]).not.toHaveBeenCalled();
    expect(errors.join('')).toContain(`invalid fleet ${verb} arguments`);
    expect(await cmdFleetRunsRead(verb, ['--help'], readers)).toBe(0);
    expect(output.at(-1)).toContain('--watch');
    expect(output.at(-1)).toContain('JSONL');
    if (verb === 'journal') expect(output.at(-1)).not.toContain('--lane');
  });

  it.each(['journal', 'parked'] as const)('stops %s without output when aborted during a read and removes listeners', async verb => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const readers = deps();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    // Assign each reader separately to retain its return type.
    if (verb === 'journal') readers.journal = vi.fn(async () => { await pending; return journal; });
    else readers.parked = vi.fn(async () => { await pending; return parked; });
    const wait = vi.fn(async () => {});
    const command = cmdFleetRunsRead(verb, ['--watch', '--json'], readers, { signal: controller.signal, wait });
    controller.abort();
    finish();
    expect(await command).toBe(0);
    expect(readers[verb]).toHaveBeenCalledOnce();
    expect(output).toEqual([]);
    expect(wait).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops cleanly on %s during an injected wait', async signal => {
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const readers = deps();
    const wait = vi.fn(async (_ms: number, abort: AbortSignal) => {
      const added = process.listeners(signal).filter(listener => !(signal === 'SIGINT' ? beforeInt : beforeTerm).includes(listener));
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
      expect(abort.aborted).toBe(true);
    });
    expect(await cmdFleetRunsRead('journal', ['--watch'], readers, { wait })).toBe(0);
    expect(readers.journal).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });
});
