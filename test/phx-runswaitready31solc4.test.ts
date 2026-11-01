import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const start = Date.parse('2026-10-31T12:00:00Z');
const snapshot = (): FleetRunsDirState => ({
  v: 1, generatedAt: new Date(start).toISOString(), runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: new Date(start).toISOString(), paused: false, memFreePct: 50, diskFreeGb: null,
  lanes: [{ lane: 'codex-personal', running: 0, target: 1, held: false, queued: 0, floor: null, ceiling: null,
    heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
});
const args = ['--wait-ready', '--lane', 'codex-personal', '--timeout-ms', '2500', '--json', '--interval-ms', '1000'];
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(line => { errors.push(String(line)); return true; });
});
afterEach(() => vi.restoreAllMocks());

async function run(samples: FleetRunsDirState[]) {
  let now = start;
  let index = 0;
  const runs = vi.fn(async () => samples[Math.min(index++, samples.length - 1)]!);
  const wait = vi.fn(async (ms: number) => { now += ms; });
  const code = await cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue }, { now: () => now, wait });
  expect(output).toHaveLength(1);
  expect(errors).toEqual([]);
  return { code, result: JSON.parse(output[0]!), runs, wait };
}

describe('fleet runs wait-ready', () => {
  it.each(['held', 'full'] as const)('waits for a %s lane to open', async blocker => {
    const blocked = snapshot();
    if (blocker === 'held') blocked.lanes[0]!.held = true;
    else blocked.lanes[0]!.running = 1;
    const { code, result, runs, wait } = await run([blocked, snapshot()]);
    expect(code).toBe(0);
    expect(result).toMatchObject({ v: 1, lane: 'codex-personal', outcome: 'ready', ready: true, reasons: [], freshness: 'fresh', ageMs: 1000 });
    expect(runs).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.map(call => call[0])).toEqual([1000]);
  });

  it.each([
    ['absent lane', (s: FleetRunsDirState) => { s.lanes = []; }, 'lane_unknown'],
    ['held lane', (s: FleetRunsDirState) => { s.lanes[0]!.held = true; }, 'lane_held'],
    ['full lane', (s: FleetRunsDirState) => { s.lanes[0]!.running = 1; }, 'lane_full'],
    ['degraded source', (s: FleetRunsDirState) => { s.sourceState = 'degraded'; s.sources.metrics = 'missing'; }, 'sources_degraded'],
    ['paused host', (s: FleetRunsDirState) => { s.paused = true; }, 'host_paused'],
    ['unknown pause', (s: FleetRunsDirState) => { s.paused = null; }, 'pause_unknown'],
    ['stale status', (s: FleetRunsDirState) => { s.lastTick = new Date(start - 60001).toISOString(); }, 'status_freshness_stale'],
    ['missing timestamp', (s: FleetRunsDirState) => { s.lastTick = null; }, 'status_freshness_unknown'],
    ['invalid timestamp', (s: FleetRunsDirState) => { s.lastTick = 'invalid'; }, 'status_freshness_unknown'],
    ['future timestamp', (s: FleetRunsDirState) => { s.lastTick = new Date(start + 60000).toISOString(); }, 'status_freshness_unknown'],
    ['unhealthy status', (s: FleetRunsDirState) => { s.sourceState = 'degraded'; s.sources.status = 'missing'; }, 'lane_capacity_unknown'],
  ])('times out with the last reason for %s', async (_name, mutate, reason) => {
    const state = snapshot(); mutate(state);
    const { code, result, runs, wait } = await run([state]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ v: 1, outcome: 'timed_out', ready: false });
    expect(result.reasons).toContain(reason);
    expect(runs).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(call => call[0])).toEqual([1000, 1000, 500]);
  });

  it('returns the last failure without exposing reader errors and recovers from them', async () => {
    let now = start;
    const runs = vi.fn().mockRejectedValueOnce(new Error('private detail')).mockResolvedValue(snapshot());
    const code = await cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue },
      { now: () => now, wait: async ms => { now += ms; } });
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!).outcome).toBe('ready');
    expect(output.join('')).not.toContain('private detail');
  });

  it('keeps the previous reasons when a ready read finishes after the deadline', async () => {
    let now = start;
    const blocked = snapshot(); blocked.lanes[0]!.held = true;
    const runs = vi.fn().mockResolvedValueOnce(blocked).mockImplementationOnce(async () => {
      now = start + 2500;
      return snapshot();
    });
    expect(await cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue },
      { now: () => now, wait: async ms => { now += ms; } })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'timed_out', ready: false, reasons: ['lane_held'] });
  });

  it('reports unknown evidence when reads fail until timeout', async () => {
    let now = start;
    const runs = vi.fn().mockRejectedValue(new Error('private detail'));
    expect(await cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue },
      { now: () => now, wait: async ms => { now += ms; } })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'timed_out', reasons: ['source_unavailable'], freshness: 'unknown' });
    expect(output.join('')).not.toContain('private detail');
  });

  it('cancels during a wait and preserves the last reasons', async () => {
    const controller = new AbortController();
    const blocked = snapshot(); blocked.paused = true;
    const runs = vi.fn(async () => blocked);
    const wait = vi.fn(async () => { controller.abort(); });
    expect(await cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue },
      { now: () => start, wait, signal: controller.signal })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'cancelled', reasons: ['host_paused'], ready: false });
    expect(runs).toHaveBeenCalledOnce();
  });

  it('does not read after cancellation before startup', async () => {
    const runs = vi.fn(async () => snapshot());
    expect(await cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue },
      { now: () => start, signal: AbortSignal.abort() })).toBe(1);
    expect(runs).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'cancelled', ready: false });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cancels an in-flight read on %s and removes listeners', async signal => {
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const runs = vi.fn(() => new Promise<FleetRunsDirState>(() => {}));
    const command = cmdFleetRunsRead('runs', args, { runs, journal: readLeaderJournal, parked: readFleetQueue }, { now: () => start });
    await Promise.resolve();
    const added = process.listeners(signal).filter(listener => !(signal === 'SIGINT' ? beforeInt : beforeTerm).includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(await command).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'cancelled', ready: false, freshness: 'unknown' });
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('rejects invalid combinations before reading and describes the observation', async () => {
    const runs = vi.fn(async () => snapshot());
    const deps = { runs, journal: readLeaderJournal, parked: readFleetQueue };
    for (const invalid of [
      ['--wait-ready', '--lane', 'codex-personal', '--timeout-ms', '1'],
      ['--wait-ready', '--json', '--timeout-ms', '1'], ['--wait-ready', '--json', '--lane', 'codex-personal'],
      ...['0', '3600001', '1.5', '-1', 'abc'].map(n => ['--wait-ready', '--json', '--lane', 'codex-personal', '--timeout-ms', n]),
      [...args, '--watch'], [...args, '--check-ready'], [...args, '--timeout-ms', '1'],
      ['--timeout-ms', '1'], ['--wait-ready', '--json', '--lane', '../bad', '--timeout-ms', '1'],
    ]) expect(await cmdFleetRunsRead('runs', invalid, deps)).toBe(2);
    expect(await cmdFleetRunsRead('journal', args, deps)).toBe(2);
    expect(runs).not.toHaveBeenCalled();
    expect(await cmdFleetRunsRead('runs', ['--help'], deps)).toBe(0);
    expect(output[0]).toContain('Capacity observation is not a reservation');
  });
});
