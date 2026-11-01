import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { FleetRunsDirState, FleetRunsLane } from '../src/core/fleet/runs-dir-state.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';

const now = Date.parse('2026-11-01T04:08:00Z');
const at = new Date(now).toISOString();
const lane = (name: string, running: number, queued: number, target = 2, held = false): FleetRunsLane => ({
  lane: name, running, queued, target, held, heldReason: held ? 'quota hold' : null,
  floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null,
});
const snapshot = (lanes: FleetRunsLane[]): FleetRunsDirState => ({
  v: 1, generatedAt: at, runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: at, paused: false, memFreePct: null, diskFreeGb: null, lanes, switches: [], claudeLane: null,
  publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
});
const ps = (rows: string) => listLiveWorkers({ now: () => now, runPs: async () => rows });
const row = (pid: number, job: string, name = 'claude') => `${pid} 00:01 /fake/bin/launch.sh ${job} phantom ${name} work`;
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation(message => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
});
afterEach(() => vi.restoreAllMocks());

async function invoke(state: FleetRunsDirState, workerRead: () => Promise<LiveWorkersSnapshot>, args = ['--check-running', '--json']) {
  const runs = vi.fn(async () => state);
  const workers = vi.fn(workerRead);
  const code = await cmdFleetRunsRead('runs', args, { runs, workers, now: () => now, journal: readLeaderJournal, parked: readFleetQueue });
  return { code, result: output.length ? JSON.parse(output.at(-1)!) : null, runs, workers };
}

describe('fleet runs launch proof', () => {
  it('fails queued work and claims without process evidence', async () => {
    const state = snapshot([lane('claude', 0, 1)]);
    state.claimed.push({ job: 'job-1', lane: 'claude', tier: 'work', at });
    const { code, result, runs, workers } = await invoke(state, () => ps(''));
    expect(code).toBe(1);
    expect(result.lanes[0]).toMatchObject({ reportedRunning: 0, observedWorkerJobs: 0, queued: 1,
      assessment: 'failure', discrepancies: ['queued_eligible_lane_has_no_observed_workers'] });
    expect(runs).toHaveBeenCalledOnce(); expect(workers).toHaveBeenCalledOnce();
  });

  it('fails reported running without workers and counts duplicate process rows once', async () => {
    let check = await invoke(snapshot([lane('claude', 10, 0)]), () => ps(''));
    expect(check.code).toBe(1);
    expect(check.result.lanes[0]).toMatchObject({ reportedRunning: 10, observedWorkerJobs: 0,
      discrepancies: ['reported_running_differs_from_observed_workers'] });
    check = await invoke(snapshot([lane('claude', 1, 3)]), () => ps(`${row(10, 'job-1')}\n${row(11, 'job-1')}`));
    expect(check.code).toBe(0);
    expect(check.result.lanes[0].observedWorkerJobs).toBe(1);
    expect(check.result.limitation).toMatch(/not proof.*provider.*consuming tokens/);
  });

  it('passes full busy lanes and scopes lane selection without hiding global source health', async () => {
    const state = snapshot([lane('claude', 2, 4, 2), lane('devin', 0, 1)]);
    const workerRead = () => ps(`${row(1, 'one')}\n${row(2, 'two')}`);
    const selected = await invoke(state, workerRead, ['--json', '--check-running', '--lane', 'claude']);
    expect(selected.code).toBe(0);
    expect(selected.result).toMatchObject({ ok: true, laneFilter: 'claude', lanes: [{ lane: 'claude', observedWorkerJobs: 2, assessment: 'observed' }] });
    const all = await invoke(state, workerRead);
    expect(all.code).toBe(1);
    expect(all.result.lanes[1].assessment).toBe('failure');
    const missing = await invoke(state, workerRead, ['--json', '--check-running', '--lane', 'absent']);
    expect(missing.code).toBe(1); expect(missing.result.reasons).toContain('lane_not_found');
  });

  it('explains held and paused lanes without declaring dispatch healthy', async () => {
    const state = snapshot([lane('claude', 0, 5, 2, true)]);
    let check = await invoke(state, () => ps(''));
    expect(check.code).toBe(0);
    expect(check.result.lanes[0]).toMatchObject({ held: true, heldReason: 'quota hold', assessment: 'held', discrepancies: [] });
    state.lanes[0] = lane('claude', 0, 5); state.paused = true;
    check = await invoke(state, () => ps(''));
    expect(check.code).toBe(0); expect(check.result.lanes[0].assessment).toBe('paused');
  });

  it('fails closed for unavailable and stale evidence without turning unknown into zero', async () => {
    const state = snapshot([lane('claude', 0, 1)]);
    let check = await invoke(state, () => listLiveWorkers({ now: () => now, runPs: async () => { throw new Error('private'); } }));
    expect(check.code).toBe(1); expect(check.result.reasons).toContain('workers_unavailable');
    expect(check.result.lanes[0]).toMatchObject({ observedWorkerJobs: null, assessment: 'unknown' });
    state.lastTick = new Date(now - 300_001).toISOString();
    check = await invoke(state, () => ps(row(1, 'one')));
    expect(check.code).toBe(1); expect(check.result.reasons).toContain('status_stale_or_invalid');
    state.lastTick = at; state.sources.status = 'degraded';
    check = await invoke(state, () => ps(''));
    expect(check.code).toBe(1); expect(check.result.reasons).toContain('status_unavailable');
    state.sources.status = 'healthy';
    check = await invoke(state, async () => ({ ...await ps(''), generatedAt: new Date(now + 30_001).toISOString() }));
    expect(check.code).toBe(1); expect(check.result.reasons).toContain('workers_stale_or_invalid');
  });

  it('reports reader exceptions without exposing details and still reads each source once', async () => {
    const runs = vi.fn(async (): Promise<FleetRunsDirState> => { throw new Error('private'); });
    const workers = vi.fn(async (): Promise<LiveWorkersSnapshot> => { throw new Error('private'); });
    const code = await cmdFleetRunsRead('runs', ['--json', '--check-running'], { runs, workers, now: () => now, journal: readLeaderJournal, parked: readFleetQueue });
    expect(code).toBe(1); expect(JSON.parse(output[0]!).reasons).toEqual(['status_unavailable', 'workers_unavailable']);
    expect(output[0]).not.toContain('private'); expect(runs).toHaveBeenCalledOnce(); expect(workers).toHaveBeenCalledOnce();
  });

  it('rejects incompatible or duplicate flags before reading; ordinary output stays unchanged', async () => {
    const state = snapshot([lane('claude', 0, 0)]);
    for (const args of [['--check-running'], ['--check-running', '--json', '--watch'],
      ['--check-running', '--json', '--sample', '1'], ['--check-running', '--json', '--check-ready'],
      ['--check-running', '--json', '--check-running'], ['--check-running', '--json', '--lane']]) {
      const check = await invoke(state, () => ps(''), args);
      expect(check.code).toBe(2); expect(check.runs).not.toHaveBeenCalled(); expect(check.workers).not.toHaveBeenCalled();
    }
    const ordinary = await invoke(state, () => ps(''), ['--json']);
    expect(ordinary.code).toBe(0); expect(ordinary.result).toEqual(state); expect(ordinary.workers).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThan(0);
  });
});
