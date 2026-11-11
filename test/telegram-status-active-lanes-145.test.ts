import { describe, expect, it } from 'vitest';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';
import type { StatusSupply } from '../src/core/comms/status-supply-line.js';
import type { FleetRunsDirState, FleetRunsLane } from '../src/core/fleet/runs-dir-state.js';
import type { LiveWorkersSnapshot, LiveWorker } from '../src/core/fleet/runs-live-workers.js';

const now = new Date('2026-11-11T07:30:00.000Z');

const lane = (over: Partial<FleetRunsLane> & { lane: string }): FleetRunsLane => ({
  running: 0, target: 0, floor: null, ceiling: null, queued: 0, held: false,
  heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null,
  ...over,
});

const runsState = (lanes: FleetRunsLane[]): FleetRunsDirState => ({
  v: 1, generatedAt: now.toISOString(), runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: '2026-11-11T07:29:00.000Z', paused: false, memFreePct: 50, diskFreeGb: 100,
  lanes, switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [],
  drop: { pending: [], done: 0 },
});

const worker = (laneName: string, pid: number): LiveWorker => ({
  pid, job: `JOB${pid}`, repo: 'phantom', lane: laneName, tier: 'work', ageSeconds: 60,
});

const workersState = (workers: LiveWorker[]): LiveWorkersSnapshot => ({
  v: 1, generatedAt: now.toISOString(), sourceState: 'healthy',
  workers, leaders: [], orchestratorAgents: 0,
});

const supply: StatusSupply = {
  v: 1, sourceState: 'healthy',
  lanes: [
    { lane: 'devin-flash', phxReady: 1, fillerReady: 0 },
    { lane: 'gemini', phxReady: 0, fillerReady: 2 },
  ],
  planner: { status: 'ok', lastGoodPassAt: '2026-11-11T07:29:00.000Z', reason: null },
};

const baseDeps = {
  readRuns: async (): Promise<FleetRunsDirState> => runsState([
    lane({ lane: 'codex-personal', running: 4, target: 3, queued: 2, held: true, tokensLastHour: 123 }),
    lane({ lane: 'devin-flash', running: 2, target: 3, queued: 1, held: false, tokensLastHour: 45 }),
    lane({ lane: 'gemini', running: 1, target: 2, queued: 4, held: true, tokensLastHour: 67 }),
    lane({ lane: 'zai', running: 3, target: 3, queued: 0, held: false, tokensLastHour: 89 }),
    lane({ lane: 'experimental-lane', running: 9, target: 9, queued: 9, held: true, tokensLastHour: 999 }),
  ]),
  readWorkers: async (): Promise<LiveWorkersSnapshot> => workersState([
    worker('codex-personal', 101),
    worker('devin-flash', 102),
    worker('devin-flash', 103),
    worker('gemini', 104),
    worker('zai', 105),
    worker('experimental-lane', 106),
    worker('experimental-lane', 107),
  ]),
  readSupply: async (): Promise<StatusSupply> => supply,
  readQuota: (): string[] => [],
  now: () => now,
};

describe('telegramFleetStatus active resource lanes', () => {
  it('keeps detailed rows for every supply-supported lane including devin-flash, gemini and zai', async () => {
    const body = await telegramFleetStatus(baseDeps);
    expect(body).toContain('codex-personal: observed 1; reported 4; queue 2; target 3; held yes; tokens/1h 123');
    expect(body).toContain('devin-flash: observed 2; reported 2; queue 1; target 3; held no; tokens/1h 45');
    expect(body).toContain('gemini: observed 1; reported 1; queue 4; target 2; held yes; tokens/1h 67');
    expect(body).toContain('zai: observed 1; reported 3; queue 0; target 3; held no; tokens/1h 89');
    for (const lane of ['codex-cmp', 'claude', 'devin', 'claude-api', 'codex-local', 'agy', 'grok', 'cursor']) {
      expect(body).toContain(`${lane}: observed 0; reported unavailable; queue unavailable; target unavailable; held unavailable; tokens/1h unavailable`);
    }
  });

  it('aggregates unrecognized lanes without revealing their names', async () => {
    const body = await telegramFleetStatus(baseDeps);
    expect(body).toContain('Other lanes: observed 2; reported/queue/target/held unavailable');
    expect(body).not.toContain('experimental-lane');
    expect(body).not.toContain('999');
  });

  it('reports worker-reader failure as unavailable, never a zero count', async () => {
    const body = await telegramFleetStatus({
      ...baseDeps,
      readWorkers: async (): Promise<LiveWorkersSnapshot> => { throw new Error('ps exploded'); },
    });
    expect(body).toContain('devin-flash: observed unavailable; reported 2; queue 1; target 3; held no; tokens/1h 45');
    expect(body).toContain('zai: observed unavailable; reported 3; queue 0; target 3; held no; tokens/1h 89');
    expect(body).toContain('Other lanes: observed unavailable; reported/queue/target/held unavailable');
    expect(body).toContain('workers=unavailable');
    expect(body).not.toMatch(/ps exploded/);
  });

  it('reports runs-reader failure as unavailable while keeping observed counts', async () => {
    const body = await telegramFleetStatus({
      ...baseDeps,
      readRuns: async (): Promise<FleetRunsDirState> => { throw new Error('runs gone'); },
    });
    expect(body).toContain('gemini: observed 1; reported unavailable; queue unavailable; target unavailable; held unavailable; tokens/1h unavailable');
    expect(body).toContain('runs=unavailable, workers=healthy');
    expect(body).not.toMatch(/runs gone/);
  });

  it('keeps supply and planner lines from the shared projection', async () => {
    const body = await telegramFleetStatus(baseDeps);
    expect(body).toContain('Supply: devin-flash 1 phantom / 0 filler; gemini 0 / 2');
    expect(body).toContain('Planner: last good pass 2026-11-11T07:29:00.000Z');
  });
});
