import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const lane = (name: string) => ({ lane: name, running: 1, target: 2, floor: null, ceiling: null,
  queued: 3, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const state: FleetRunsDirState = {
  v: 1, generatedAt: '2026-10-31T00:00:00Z', runsDirPresent: true, sourceState: 'degraded',
  sources: { status: 'healthy', claimed: 'healthy', events: 'missing', metrics: 'degraded', claudeLane: 'missing', switches: 'healthy', drop: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane('fake-a'), lane('fake-b')],
  claimed: ['fake-a', 'fake-b'].map(name => ({ job: name, lane: name, tier: 'fake', at: 'fake' })),
  publishesLastHour: ['fake-a', 'fake-b'].map(name => ({ job: name, lane: name, url: null, at: 'fake' })),
  events: [{ at: 'fake', kind: 'fake', text: 'fake' }],
  drop: { pending: ['fake-a', 'fake-b'].map(name => ({ lane: name, file: 'fake.md' })), done: 2 },
};
const deps = (runs = vi.fn(async () => state)) => ({ runs, journal: readLeaderJournal, parked: readFleetQueue });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet runs watch', () => {
  it('samples immediately, retries a failed read, and filters every recovered JSONL snapshot', async () => {
    const controller = new AbortController();
    const runs = vi.fn().mockResolvedValueOnce(state).mockRejectedValueOnce(new Error('fake private detail'))
      .mockResolvedValueOnce({ ...state, generatedAt: 'later', sourceState: 'healthy' });
    let ticks = 0;
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => { if (++ticks === 3) controller.abort(); });
    expect(await cmdFleetRunsRead('runs', ['--watch', '--json', '--lane', 'fake-a'], deps(runs), { signal: controller.signal, wait })).toBe(0);
    expect(runs).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(call => call[0])).toEqual([5000, 5000, 5000]);
    expect(output).toHaveLength(3);
    const [first, failure, recovered] = output.map(line => JSON.parse(line));
    expect(failure).toEqual({ error: 'fleet runs unavailable' });
    expect(output.join('\n')).not.toContain('fake private detail');
    for (const sample of [first, recovered]) {
      expect(sample).toMatchObject({ lanes: [{ lane: 'fake-a' }], claimed: [{ lane: 'fake-a' }],
        publishesLastHour: [{ lane: 'fake-a' }], events: [], drop: { pending: [{ lane: 'fake-a' }], done: 2 },
        sources: state.sources, laneFilter: { lane: 'fake-a', omitted: ['events'] } });
    }
    expect(first.sourceState).toBe('degraded');
    expect(recovered).toMatchObject({ sourceState: 'healthy', generatedAt: 'later' });
    expect(errors).toEqual([]);
  });

  it('waits for each read to finish and does not read after aborting in flight', async () => {
    const controller = new AbortController();
    const pending = deferred<FleetRunsDirState>();
    const runs = vi.fn(() => pending.promise);
    const wait = vi.fn(async () => {});
    const command = cmdFleetRunsRead('runs', ['--watch', '--json'], deps(runs), { signal: controller.signal, wait });
    expect(runs).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    controller.abort();
    pending.resolve(state);
    expect(await command).toBe(0);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(output).toEqual([]);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops before the first read or during an interruptible wait', async () => {
    const controller = new AbortController();
    controller.abort();
    const unread = deps();
    expect(await cmdFleetRunsRead('runs', ['--watch'], unread, { signal: controller.signal })).toBe(0);
    expect(unread.runs).not.toHaveBeenCalled();
    const next = new AbortController();
    const waiting = deferred<void>();
    const entered = deferred<void>();
    const wait = vi.fn((_ms: number, signal: AbortSignal) => {
      signal.addEventListener('abort', () => waiting.resolve(), { once: true });
      entered.resolve();
      return waiting.promise;
    });
    const read = deps();
    const command = cmdFleetRunsRead('runs', ['--watch', '--json', '--interval-ms', '1000'], read, { signal: next.signal, wait });
    await entered.promise;
    expect(wait).toHaveBeenCalledOnce();
    next.abort();
    expect(await command).toBe(0);
    expect(read.runs).toHaveBeenCalledOnce();
    expect(wait.mock.calls[0]![0]).toBe(1000);
  });

  it('rejects invalid and unsupported watch options before any read', async () => {
    const readers = deps();
    const invalid = [
      ['--interval-ms', '1000'], ['--watch', '--watch'], ['--watch', '--interval-ms'],
      ['--watch', '--interval-ms', '999'], ['--watch', '--interval-ms', '60001'],
      ['--watch', '--interval-ms', '1e3'], ['--watch', '--interval-ms', '1000.5'],
      ['--watch', '--interval-ms', '1000', '--interval-ms', '2000'], ['--help', '--watch', '--bad'],
    ];
    for (const args of invalid) expect(await cmdFleetRunsRead('runs', args, readers)).toBe(2);
    for (const verb of ['journal', 'parked'] as const) {
      expect(await cmdFleetRunsRead(verb, ['--watch'], readers)).toBe(2);
      expect(await cmdFleetRunsRead(verb, ['--interval-ms', '1000'], readers)).toBe(2);
    }
    expect(readers.runs).not.toHaveBeenCalled();
    expect(errors.join('')).toContain('invalid fleet runs arguments');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cleans up signal listeners after %s during the default wait', async signal => {
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const readers = deps();
    const command = cmdFleetRunsRead('runs', ['--watch', '--json'], readers);
    await Promise.resolve();
    const added = process.listeners(signal).filter(listener => !(signal === 'SIGINT' ? beforeInt : beforeTerm).includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(await command).toBe(0);
    expect(readers.runs).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('cleans up listeners even if an injected wait fails', async () => {
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(cmdFleetRunsRead('runs', ['--watch'], deps(), { signal: controller.signal, wait: async () => { throw new Error('fake wait failure'); } })).rejects.toThrow('fake wait failure');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });
});
