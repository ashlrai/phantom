import { describe, expect, it } from 'vitest';
import { emailFleetStatus, type EmailFleetStatusReaders } from '../src/core/comms/email-fleet-status.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { StatusSupply } from '../src/core/comms/status-supply-line.js';

const AT = new Date('2026-11-11T12:00:00.000Z');
const now = () => AT;
const tick = (msAgo: number) => new Date(AT.getTime() - msAgo).toISOString();

function runsState(over: Partial<FleetRunsDirState> = {}): FleetRunsDirState {
  return {
    v: 1, generatedAt: AT.toISOString(), runsDirPresent: true, sourceState: 'healthy',
    sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
    lastTick: tick(5_000), paused: false, memFreePct: 50, diskFreeGb: 100,
    lanes: [{ lane: 'devin', running: 2, target: 3, floor: null, ceiling: null, queued: 1, held: true, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
    switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [],
    drop: { pending: [], done: 0 },
    ...over,
  };
}

const workers: LiveWorkersSnapshot = {
  v: 1, generatedAt: AT.toISOString(), sourceState: 'healthy',
  workers: [{ pid: 7, job: 'job-a', repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 5 }],
  leaders: [{ pid: 9, label: 'leader-pass', ageSeconds: 10 }],
  orchestratorAgents: 2,
};

const supply: StatusSupply = {
  v: 1, sourceState: 'healthy',
  lanes: [{ lane: 'devin', phxReady: 4, fillerReady: 1 }],
  planner: { status: 'ok', lastGoodPassAt: '2026-11-11T11:00:00.000Z', reason: null },
};

function readers(state: FleetRunsDirState): EmailFleetStatusReaders {
  return { runs: async () => state, workers: async () => workers, supply: async () => supply, readQuota: () => ['Quota Devin: test: 10%'] };
}

const RUN_LINES = [/^running:/m, /^target:/m, /^queued:/m, /^held lanes:/m, /paused:/];

describe('email fleet status dispatcher freshness', () => {
  it('prints live counts for a healthy source whose last tick is inside the 60-second window', async () => {
    const body = await emailFleetStatus(undefined, now, readers(runsState({ lastTick: tick(60_000) })));
    expect(body).toContain('Runs status: available; paused: no');
    expect(body).toContain('running: 2');
    expect(body).toContain('target: 3');
    expect(body).toContain('queued: 1');
    expect(body).toContain('held lanes: 1');
  });

  it('labels a tick older than 60 seconds stale and withholds the counts', async () => {
    const body = await emailFleetStatus(undefined, now, readers(runsState({ lastTick: tick(60_001) })));
    expect(body).toContain(`Runs status: stale; last tick: ${tick(60_001)}`);
    for (const pattern of RUN_LINES) expect(body).not.toMatch(pattern);
    expect(body).not.toContain('paused:');
  });

  it('labels a much older tick stale with only the bounded observation timestamp', async () => {
    const body = await emailFleetStatus(undefined, now, readers(runsState({ lastTick: tick(3_600_000) })));
    expect(body).toContain('Runs status: stale; last tick:');
    expect(body).not.toMatch(/running:|target:|queued:|held lanes:|paused:/);
    expect(body.length).toBeLessThan(2000);
  });

  it('rejects a future last tick instead of reporting it as current', async () => {
    const body = await emailFleetStatus(undefined, now, readers(runsState({ lastTick: new Date(AT.getTime() + 1_000).toISOString() })));
    expect(body).toContain('Runs status: stale; last tick:');
    expect(body).not.toMatch(/running:|target:|queued:|held lanes:|paused:/);
  });

  it.each([
    ['missing', null],
    ['invalid', 'not-a-timestamp'],
  ])('reports unavailable for a %s last tick', async (_name, lastTick) => {
    const body = await emailFleetStatus(undefined, now, readers(runsState({ lastTick: lastTick as string | null })));
    expect(body).toContain('Runs status: unavailable');
    expect(body).not.toMatch(/running:|target:|queued:|held lanes:|paused:/);
    expect(body).not.toContain('last tick');
  });

  it('withholds dispatcher counts when the report clock is unavailable', async () => {
    const body = await emailFleetStatus(undefined, () => new Date(NaN), readers(runsState()));
    expect(body).toContain('Phantom fleet status (unavailable)');
    expect(body).toContain('Runs status: unavailable');
    expect(body).not.toMatch(/running:|target:|queued:|held lanes:|paused:/);
  });

  it('still prints explicit zero counts for a fresh dispatcher', async () => {
    const state = runsState({
      paused: true,
      lanes: [{ lane: 'devin', running: 0, target: 0, floor: null, ceiling: null, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
    });
    const body = await emailFleetStatus(undefined, now, readers(state));
    expect(body).toContain('Runs status: available; paused: yes');
    expect(body).toContain('running: 0');
    expect(body).toContain('target: 0');
    expect(body).toContain('queued: 0');
    expect(body).toContain('held lanes: 0');
  });

  it('keeps independent worker, supply and quota evidence when dispatcher freshness is unprovable', async () => {
    const body = await emailFleetStatus(undefined, now, readers(runsState({ lastTick: tick(600_000) })));
    expect(body).toContain('Runs status: stale; last tick:');
    expect(body).toContain('Live workers: 1');
    expect(body).toContain('Leader passes: 1');
    expect(body).toContain('Orchestrator agents: 2');
    expect(body).toContain('Supply: devin 4 phantom / 1 filler');
    expect(body).toContain('Planner: last good pass 2026-11-11T11:00:00.000Z');
    expect(body).toContain('Quota Devin: test: 10%');
    expect(body.length).toBeLessThan(2000);
  });

  it('keeps counts-only privacy: lane labels and free text never reach the email', async () => {
    const state = runsState({
      lastTick: tick(60_000),
      lanes: [{ lane: 'private-lane-name', running: 1, target: 2, floor: null, ceiling: null, queued: 0, held: false, heldReason: '/private/secret path', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
    });
    const body = await emailFleetStatus(undefined, now, readers(state));
    expect(body).toContain('running: 1');
    expect(body).not.toMatch(/private|secret|lane-name/);
  });
});
