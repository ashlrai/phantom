import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { clockTime } from '../leader/thread-model.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../ops/lane-targets-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { laneLine, lanesLine, namedLane, runLaneCommand, runLanesCommand, LANE_JOBS_LIMIT } from './composer-lane-commands.js';

const NOW = Date.parse('2026-11-20T12:00:30Z');
const UNTIL = '2026-11-20T14:05:00Z';

const lane = (name: string, over: Partial<FleetRuns['lanes'][number]> = {}): FleetRuns['lanes'][number] => ({
  lane: name, running: 0, target: 0, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null, ...over,
});
const worker = (job: string, laneName: string, ageSeconds: number | null = 720) => ({ job, repo: 'ashlrai/phantom', lane: laneName, tier: 'mid', ageSeconds });

function runs(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    ...fleetRunsFixture() as FleetRuns,
    lastTick: '2026-11-20T12:00:18Z',
    lanes: [
      lane('claude', { running: 3, target: 4, queued: 2, tokensLastHour: 1_200_000, merged24h: 14, mergeRate24h: 0.58 }),
      lane('codex-personal', { running: 4, target: 4 }),
      lane('glm', { running: 1, target: 2, held: true, heldReason: 'provider outage.' }),
      lane('kimi'),
    ],
    workers: [worker('RQ-NEW', 'claude', 60), worker('RQ-OLD', 'claude', 7_500), worker('RQ-GLM', 'glm', null)],
    mergesLastHour: { count: 4, items: [] },
    ...over,
  };
}

const row = (name: string, over: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane: name, target: 4, floor: 0, ceiling: 6, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null, ...over,
});
const targets = (rows: LaneTargetRow[] = [row('claude'), row('glm', { target: 2, held: true, heldReason: 'provider outage', heldUntil: UNTIL })]): LaneTargetsV1 =>
  ({ v: 1, generatedAt: '2026-11-20T12:00:00Z', sourceState: 'healthy', lanes: rows });

describe('lanesLine', () => {
  it('gives the headline, then every lane with the held one first and the switched-off one last', () => {
    expect(lanesLine(runs(), targets(), NOW)).toBe(
      'Lanes: 8 of 10 slots running, 1 lane held. '
      + `glm held until ${clockTime(UNTIL)} (provider outage), 1 running · claude 3 of 4, 2 waiting · codex-personal 4 of 4 · kimi target 0. `
      + '4 merged last hour · last tick 12 s ago. '
      + '/lane <lane> names its jobs; /open fleet-lanes has the board.');
  });

  it('keeps a hold without an end time, and a hold without a reason, as what they are', () => {
    const line = lanesLine(runs({ lanes: [lane('glm', { running: 0, target: 2, held: true })] }), null, NOW);
    expect(line).toContain('glm held (reason not recorded), 0 running.');
    expect(line).not.toContain('until');
  });

  it('names the Claude lane as down with the reason on record, ahead of the rest', () => {
    const line = lanesLine(runs({ claudeLane: 'down: login expired' }), targets(), NOW);
    expect(line).toContain('claude down (login expired), 3 running, 2 waiting · glm held');
  });

  it('says the fleet is paused, that the pause is unknown, and that the record is not whole', () => {
    expect(lanesLine(runs({ paused: true }), null, NOW)).toContain(' The fleet is paused. ');
    expect(lanesLine(runs({ paused: null }), null, NOW)).toContain(' Whether the fleet is paused is unknown. ');
    const partial = runs();
    partial.sources = { ...partial.sources, workers: 'degraded' };
    expect(lanesLine(partial, null, NOW)).toContain('The runs record is not whole, so these counts may be incomplete.');
    expect(lanesLine(runs(), null, NOW)).not.toMatch(/paused|not whole/);
  });

  it('keeps unknown readings unknown and says when no lane is reported', () => {
    const none = lanesLine(runs({ lanes: [], lastTick: null, mergesLastHour: { count: null, items: [] } }), null, NOW);
    expect(none).toBe('No lanes reported. Merges last hour unknown · last tick unknown.');
  });
});

describe('namedLane', () => {
  it('takes the exact name first, then the only lane that starts with what was typed', () => {
    const all = runs({ lanes: [lane('codex'), lane('codex-personal'), lane('claude')] });
    expect(namedLane(all, 'codex')).toEqual({ kind: 'one', lane: 'codex' });
    expect(namedLane(all, ' CL ')).toEqual({ kind: 'one', lane: 'claude' });
    expect(namedLane(all, 'c')).toEqual({ kind: 'several', names: ['codex', 'codex-personal', 'claude'] });
    expect(namedLane(all, 'zz')).toEqual({ kind: 'none' });
    expect(namedLane(all, '')).toEqual({ kind: 'none' });
  });
});

describe('laneLine', () => {
  it('says where the lane stands, names its jobs oldest first, and gives its readings', () => {
    expect(laneLine(runs(), targets(), 'claude', NOW)).toBe(
      'claude: 3 of 4 running, 1 open, 2 waiting. Target 4, from 0 to 6. '
      + 'Running: RQ-OLD (phantom, mid, 2 h 5 min) · RQ-NEW (phantom, mid, 1 min). '
      + 'Tokens last hour 1.2M · Merged in 24 h 14 · Merge rate 0.6/h.');
  });

  it('gives a held lane its reason and end time, a job of unknown age, and unknown readings as unknown', () => {
    expect(laneLine(runs(), targets(), 'glm', NOW)).toBe(
      `glm: held until ${clockTime(UNTIL)} (provider outage), 1 of 2 running. Target 2, from 0 to 6. `
      + 'Running: RQ-GLM (phantom, mid, age unknown). '
      + 'Tokens last hour unknown · Merged in 24 h unknown · Merge rate unknown.');
  });

  it('does not call a lane empty when the snapshot counts jobs it does not name', () => {
    expect(laneLine(runs(), null, 'codex-personal', NOW)).toContain('codex-personal: 4 of 4 running. The snapshot counts 4 running but names no job.');
    expect(laneLine(runs(), null, 'kimi', NOW)).toContain('kimi: target 0, nothing running. No job is running on it.');
  });

  it('adds claimed jobs, the recorded reason a lane is not running, and counts jobs past the limit', () => {
    const many = Array.from({ length: LANE_JOBS_LIMIT + 3 }, (_, index) => worker(`RQ-J${index}`, 'claude', 600 - index));
    const line = laneLine(runs({
      workers: many,
      claimed: [{ job: 'RQ-NEXT', lane: 'claude', tier: 'mid', at: '2026-11-20T12:00:00Z' }],
      notRunning: [{ job_or_lane: 'claude', kind: 'idle_lane', reason: 'no job fits the lane', since: null, unblock: 'Drop a job for claude.' },
        { job_or_lane: 'glm', kind: 'held_launch', reason: 'held', since: null, unblock: 'Release it.' }],
    }), null, 'claude', NOW);
    expect(line).toContain(`RQ-J${LANE_JOBS_LIMIT - 1} (phantom, mid, 9 min) · and 3 more.`);
    expect(line).toContain('Claimed, not yet running: RQ-NEXT.');
    expect(line).toContain('Not running: no job fits the lane. Drop a job for claude.');
    expect(line).not.toContain('Release it.');
  });
});

describe('runLanesCommand and runLaneCommand', () => {
  const deps = (over: Partial<Parameters<typeof runLanesCommand>[0]> = {}) => ({ runs: async () => runs(), targets: async () => targets(), ...over });

  it('answers from the runs read alone when the targets read fails', async () => {
    const line = await runLanesCommand(deps({ targets: async () => { throw new Error('boom'); } }), NOW);
    expect(line).toContain('glm held (provider outage), 1 running');
  });

  it('says the lanes are unknown, with the reason, instead of an empty fleet', async () => {
    expect(await runLanesCommand(deps({ runs: async () => null }), NOW)).toBe('Lanes are unknown: this server does not serve the live runs read.');
    const refused = await runLanesCommand(deps({ runs: async () => { throw new ApiError('Service unavailable', 503, '/api/verse/fleet/runs'); } }), NOW);
    expect(refused).toMatch(/^Lanes are unknown\. /);
    expect(await runLaneCommand('claude', deps({ runs: async () => null }), NOW)).toBe('Lanes are unknown: this server does not serve the live runs read.');
  });

  it('/lane takes a start of the name, and runs nothing it cannot place', async () => {
    expect(await runLaneCommand('cl', deps(), NOW)).toMatch(/^claude: 3 of 4 running/);
    expect(await runLaneCommand('zz', deps(), NOW)).toBe('No lane is named "zz". The lanes are claude, codex-personal, glm, kimi.');
    expect(await runLaneCommand('c', deps(), NOW)).toBe('"c" fits claude, codex-personal. Type more of the name.');
  });
});
