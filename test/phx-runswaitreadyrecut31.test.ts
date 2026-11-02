import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const start = Date.parse('2026-11-01T04:00:00Z');
const fixture = (): FleetRunsDirState => ({
  v: 1, generatedAt: new Date(start).toISOString(), runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: new Date(start).toISOString(), paused: false, memFreePct: 60, diskFreeGb: null,
  lanes: [{ lane: 'fake-lane', running: 0, target: 2, held: false, queued: 0, floor: null, ceiling: null,
    heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
});
const waitArgs = ['--wait-ready', '--lane', 'fake-lane', '--timeout-ms', '3000', '--interval-ms', '1000', '--json'];
const deps = (runs: () => Promise<FleetRunsDirState>) => ({ runs, journal: readLeaderJournal, parked: readFleetQueue });
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(line => { errors.push(String(line)); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet runs --wait-ready acceptance', () => {
  it('exits 0 within one read when the lane already has usable capacity', async () => {
    const runs = vi.fn(async () => fixture());
    const wait = vi.fn(async () => {});
    const code = await cmdFleetRunsRead('runs', waitArgs, deps(runs), { now: () => start, wait });
    expect(code).toBe(0);
    expect(runs).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ v: 1, lane: 'fake-lane', outcome: 'ready', ready: true,
      reasons: [], freshness: 'fresh', ageMs: 0, paused: false, sourceState: 'healthy' });
  });

  it('polls a held lane at --interval-ms on the injected clock and exits 1 with outcome timeout', async () => {
    const held = fixture();
    held.lanes[0]!.held = true;
    held.lanes[0]!.heldReason = 'fake hold';
    let now = start;
    const runs = vi.fn(async () => held);
    const wait = vi.fn(async (ms: number) => { now += ms; });
    const code = await cmdFleetRunsRead('runs', waitArgs, deps(runs), { now: () => now, wait });
    expect(code).toBe(1);
    expect(runs).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(call => call[0])).toEqual([1000, 1000, 1000]);
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({ v: 1, lane: 'fake-lane', outcome: 'timeout', ready: false, freshness: 'fresh' });
    expect(result.reasons).toContain('lane_held');
    expect(errors).toEqual([]);
  });

  it.each([
    ['--timeout-ms 0', ['--wait-ready', '--lane', 'fake-lane', '--timeout-ms', '0', '--json']],
    ['a missing --lane', ['--wait-ready', '--timeout-ms', '3000', '--json']],
    ['--wait-ready without --json', ['--wait-ready', '--lane', 'fake-lane', '--timeout-ms', '3000']],
  ])('exits 2 with a usage line for %s', async (_name, invalid) => {
    const runs = vi.fn(async () => fixture());
    expect(await cmdFleetRunsRead('runs', invalid, deps(runs), { now: () => start })).toBe(2);
    expect(runs).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(errors.join('')).toContain('Usage: phm fleet runs');
    expect(errors.join('')).toContain('--wait-ready --lane <lane> --timeout-ms <1..3600000>');
  });

  it('leaves --watch sampling and its JSONL stream unchanged', async () => {
    const controller = new AbortController();
    const runs = vi.fn(async () => fixture());
    const wait = vi.fn(async () => { controller.abort(); });
    const code = await cmdFleetRunsRead('runs', ['--watch', '--json'], deps(runs), { signal: controller.signal, wait });
    expect(code).toBe(0);
    expect(runs).toHaveBeenCalledOnce();
    expect(wait.mock.calls.map(call => call[0])).toEqual([5000]);
    expect(JSON.parse(output[0]!)).toMatchObject({ v: 1, sourceState: 'healthy', lanes: [{ lane: 'fake-lane' }] });
  });
});
