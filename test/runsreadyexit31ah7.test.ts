import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetRunsDirState, FleetRunsLane } from '../src/core/fleet/runs-dir-state.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { cmdFleet } from '../src/cli/fleet.js';

const mocked = vi.hoisted(() => ({ runs: vi.fn() }));
vi.mock('../src/core/fleet/runs-dir-state.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/runs-dir-state.js')>(),
  readFleetRunsDirState: mocked.runs,
}));

const lane = (id: string, running: number, target: number, held = false): FleetRunsLane => ({
  lane: id, running, target, held, floor: null, ceiling: null, queued: 0, heldReason: null,
  tokensLastHour: null, merged24h: null, mergeRate24h: null,
});
const state = (): FleetRunsDirState => ({
  v: 1, generatedAt: '2026-10-31T00:00:00Z', runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy',
    claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: '2026-10-31T00:00:00Z', paused: false, memFreePct: null, diskFreeGb: null,
  lanes: [lane('codex-personal', 0, 1)], switches: [], claudeLane: null,
  publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
});
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  mocked.runs.mockReset();
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
});
afterEach(() => vi.restoreAllMocks());

async function check(snapshot: FleetRunsDirState) {
  const runs = vi.fn(async () => snapshot);
  const code = await cmdFleetRunsRead('runs', ['--json', '--check-ready'], { runs, journal: readLeaderJournal, parked: readFleetQueue });
  expect(runs).toHaveBeenCalledOnce();
  expect(output).toHaveLength(1);
  expect(errors).toEqual([]);
  return { code, result: JSON.parse(output[0]!) };
}

describe('fleet runs readiness', () => {
  it('reports a genuinely absent first-run directory without inventing values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phm-ready-'));
    try {
      const actual = await vi.importActual<typeof import('../src/core/fleet/runs-dir-state.js')>('../src/core/fleet/runs-dir-state.js');
      const snapshot = await actual.readFleetRunsDirState({ runsDir: join(root, 'absent') });
      const { code, result } = await check(snapshot);
      expect(code).toBe(1);
      expect(result).toMatchObject({ ready: false, directoryPresent: false, sourceState: 'missing', paused: null,
        eligibleLaneIds: null, reasons: ['runs_directory_absent', 'sources_missing', 'pause_unknown', 'lane_capacity_unknown'] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports pause even when lane capacity is observed', async () => {
    const { code, result } = await check({ ...state(), paused: true });
    expect(code).toBe(1);
    expect(result).toMatchObject({ ready: false, paused: true, reasons: ['host_paused'], eligibleLaneIds: ['codex-personal'] });
  });

  it('does not count held lanes with spare capacity', async () => {
    const { code, result } = await check({ ...state(), lanes: [lane('claude', 0, 3, true)] });
    expect(code).toBe(1);
    expect(result).toMatchObject({ ready: false, reasons: ['no_eligible_lanes'], eligibleLaneIds: [] });
  });

  it('reports no capacity when all unheld lanes are saturated', async () => {
    const { code, result } = await check({ ...state(), lanes: [lane('claude', 2, 2), lane('devin', 2, 1)] });
    expect(code).toBe(1);
    expect(result).toMatchObject({ ready: false, reasons: ['no_eligible_lanes'], eligibleLaneIds: [] });
  });

  it('returns free unheld lanes through the public fleet dispatcher', async () => {
    const snapshot = { ...state(), lanes: [lane('claude', 1, 2), lane('devin', 0, 1, true), lane('codex-personal', 2, 2)] };
    mocked.runs.mockResolvedValue(snapshot);
    expect(await cmdFleet(['runs', '--check-ready', '--json'])).toBe(0);
    expect(mocked.runs).toHaveBeenCalledOnce();
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ready: true, reasons: [], eligibleLaneIds: ['claude'],
      directoryPresent: true, sourceState: 'healthy', sources: snapshot.sources, paused: false });
    expect(errors).toEqual([]);
  });

  it('keeps capacity and directory unknown when their sources are degraded', async () => {
    const snapshot = state();
    snapshot.runsDirPresent = false;
    snapshot.sourceState = 'degraded';
    snapshot.sources.status = 'degraded';
    snapshot.paused = null;
    const { code, result } = await check(snapshot);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ready: false, directoryPresent: null, paused: null, eligibleLaneIds: null,
      reasons: ['runs_directory_unknown', 'sources_degraded', 'pause_unknown', 'lane_capacity_unknown'] });
  });

  it('does not declare readiness if any source is unhealthy', async () => {
    const snapshot = state();
    snapshot.sourceState = 'degraded';
    snapshot.sources.metrics = 'missing';
    const { code, result } = await check(snapshot);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ready: false, reasons: ['sources_degraded'], eligibleLaneIds: ['codex-personal'], sources: { metrics: 'missing' } });
  });

  it('returns a JSON failure without leaking a reader exception', async () => {
    mocked.runs.mockRejectedValue(new Error('private detail'));
    expect(await cmdFleet(['runs', '--json', '--check-ready'])).toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({ ready: false, reasons: ['source_unavailable'], eligibleLaneIds: null,
      directoryPresent: null, sourceState: null, sources: null, paused: null });
    expect(errors).toEqual([]);
  });

  it('validates combinations before reading and documents the contract', async () => {
    for (const args of [
      ['runs', '--check-ready'], ['runs', '--json', '--check-ready', '--watch'],
      ['runs', '--json', '--check-ready', '--lane', 'claude'], ['runs', '--json', '--check-ready', '--check-ready'],
      ['journal', '--json', '--check-ready'], ['parked', '--json', '--check-ready'],
    ]) expect(await cmdFleet(args)).toBe(2);
    expect(mocked.runs).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(await cmdFleet(['runs', '--help'])).toBe(0);
    expect(output[0]).toContain('--check-ready requires --json');
    expect(output[0]).toContain('Exit 0');
    expect(output[0]).toContain('evidence for the leader');
  });

  it('preserves the ordinary runs JSON response and exit status', async () => {
    const snapshot = state();
    mocked.runs.mockResolvedValue(snapshot);
    expect(await cmdFleet(['runs', '--json'])).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual(snapshot);
    expect(errors).toEqual([]);
  });
});
