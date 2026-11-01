import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const injected = vi.hoisted(() => ({ runs: vi.fn(), runPs: vi.fn() }));
vi.mock('../src/core/fleet/runs-dir-state.js', () => ({ readFleetRunsDirState: injected.runs }));
vi.mock('../src/core/fleet/runs-live-workers.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/core/fleet/runs-live-workers.js')>();
  return { ...original, listLiveWorkers: () => original.listLiveWorkers({ runPs: injected.runPs }) };
});
import { cmdFleet } from '../src/cli/fleet.js';

const at = '2026-11-01T04:08:00.000Z';
function snapshot(running = 1): FleetRunsDirState {
  return {
    v: 1, generatedAt: at, runsDirPresent: true, sourceState: 'healthy',
    sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
    lastTick: at, paused: false, memFreePct: null, diskFreeGb: null,
    lanes: ['claude', 'devin'].map(lane => ({ lane, running, queued: 2, target: 3, held: false, heldReason: null,
      floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null })),
    switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
  };
}
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  injected.runs.mockReset().mockResolvedValue(snapshot());
  // Fictional process rows only: no host process table or real job IDs.
  injected.runPs.mockReset().mockResolvedValue('900001 00:01 /fake/bin/launch.sh fake-job-claude phantom claude work\n900002 00:02 /fake/bin/launch.sh fake-job-devin phantom devin work');
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function invoke() {
  const code = await cmdFleet(['launch-proof', '--json']);
  const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  expect(injected.runs).toHaveBeenCalledOnce();
  expect(injected.runPs).toHaveBeenCalledOnce();
  return { code, result };
}
describe('fleet launch-proof through dynamic fallback', () => {
  it('exits zero when every running lane has matching observed workers', async () => {
    const { code, result } = await invoke();
    expect(code).toBe(0);
    expect(result).toMatchObject({ ok: true, unavailable: false });
    expect(result.lanes).toHaveLength(2);
    expect(result.lanes.every((lane: { observedWorkerJobs: number }) => lane.observedWorkerJobs === 1)).toBe(true);
  });
  it('exits one with discrepancies for three reported jobs and one observed worker', async () => {
    const state = snapshot(); state.lanes[0]!.running = 3;
    injected.runs.mockResolvedValue(state);
    const { code, result } = await invoke();
    expect(code).toBe(1);
    expect(result.lanes[0]).toMatchObject({ reportedRunning: 3, observedWorkerJobs: 1,
      discrepancies: ['reported_running_differs_from_observed_workers'] });
  });
  it('exits one with unavailable for a stale snapshot', async () => {
    injected.runs.mockResolvedValue({ ...snapshot(), lastTick: '2026-11-01T04:02:59.999Z' });
    const { code, result } = await invoke();
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, unavailable: true, reasons: ['status_stale_or_invalid'] });
    expect(result.lanes[0].assessment).toBe('unknown');
  });
});
