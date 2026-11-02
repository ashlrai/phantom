import { afterEach, expect, it, vi } from 'vitest';
import type { FleetLiveRun, FleetLiveSnapshotV1 } from '../src/core/fleet/fleet-types.js';
import { computeLaneHealth, laneHealthLine, stuckBadge } from '../src/core/fleet/lane-health.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
function run(p: Partial<FleetLiveRun>): FleetLiveRun {
  return { id: 'r', taskId: null, repo: 'a/b', title: 't', lane: 'codex', seatId: null, engine: null, model: null,
    phase: 'producing', startedAt: at(5), phaseStartedAt: at(5), endedAt: null, outcome: null, prNumber: null,
    hold: null, seatDecision: null, ...p };
}
function snap(runs: FleetLiveRun[], commit: string | null = 'abc1234'): FleetLiveSnapshotV1 {
  return { v: 1, generatedAt: new Date(NOW).toISOString(), commit, runs,
    lanes: [{ lane: 'codex', slots: 2, busy: 1, capReason: null }, { lane: 'local', slots: 1, busy: 0, capReason: null }],
  } as unknown as FleetLiveSnapshotV1;
}

afterEach(() => vi.restoreAllMocks());

it('counts calls, error rate and latency over the window, unknown when unmeasured', () => {
  const h = computeLaneHealth(snap([
    run({ id: '1', startedAt: at(60), endedAt: at(50), outcome: 'merged', phase: 'watching' }),
    run({ id: '2', startedAt: at(40), endedAt: at(20), outcome: 'failed', phase: 'producing' }),
    run({ id: '3', startedAt: at(30), endedAt: at(29), outcome: 'merged', phase: 'watching' }),
    run({ id: '4', startedAt: at(13 * 60), endedAt: at(12.9 * 60), outcome: 'failed', phase: 'watching' }),
  ]));
  const codex = h.lanes.find((l) => l.lane === 'codex')!;
  expect(codex).toMatchObject({ calls: 3, latencyP50Ms: 10 * 60_000, commit: 'abc1234', stuck: [] });
  expect(codex.errorRate).toBeCloseTo(1 / 3);
  expect(h.window.hours).toBe(12);
  const local = h.lanes.find((l) => l.lane === 'local')!;
  expect(local).toMatchObject({ calls: 0, errorRate: null, latencyP50Ms: null });
  expect(laneHealthLine(local)).toBe('0 calls · unknown errors · unknown p50 · commit abc1234');
  expect(laneHealthLine(computeLaneHealth(snap([], null)).lanes[0]!)).toContain('commit unknown');
});

it('flags a run past its phase timeout with phase age, not one within it or one that waits by design', () => {
  const h = computeLaneHealth(snap([
    run({ id: 'hung', phaseStartedAt: at(47) }),
    run({ id: 'fine', phaseStartedAt: at(44) }),
    run({ id: 'watch', phase: 'watching', phaseStartedAt: at(600) }),
    run({ id: 'unknown-age', phaseStartedAt: null, startedAt: null }),
    run({ id: 'done', phaseStartedAt: at(90), endedAt: at(1), outcome: 'merged' }),
  ]));
  const codex = h.lanes[0]!;
  expect(codex.stuck).toEqual([{ runId: 'hung', repo: 'a/b', phase: 'producing', phaseAgeMs: 47 * 60_000, timeoutMs: 45 * 60_000 }]);
  expect(stuckBadge(codex)).toBe('stuck · producing 47m');
  expect(stuckBadge(h.lanes[1]!)).toBeNull();
});
