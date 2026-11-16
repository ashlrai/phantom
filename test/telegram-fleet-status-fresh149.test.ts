import { describe, expect, it } from 'vitest';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { StatusSupply } from '../src/core/comms/status-supply-line.js';

const at = new Date('2026-11-11T07:30:00.000Z');
const runs: FleetRunsDirState = {
  v: 1, generatedAt: at.toISOString(), runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: at.toISOString(), paused: false, memFreePct: 50, diskFreeGb: 100,
  lanes: [{ lane: 'codex-personal', running: 4, queued: 2, target: 3, held: true, heldReason: null, floor: null, ceiling: null, tokensLastHour: 123, merged24h: null, mergeRate24h: null }],
  switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
};
const workers: LiveWorkersSnapshot = {
  v: 1, generatedAt: at.toISOString(), sourceState: 'healthy', leaders: [], orchestratorAgents: 0,
  workers: [{ pid: 1, job: 'JOB', repo: 'phantom', lane: 'codex-personal', tier: 'work', ageSeconds: 5 }],
};
const supply: StatusSupply = { v: 1, sourceState: 'healthy', lanes: [{ lane: 'devin', phxReady: 2, fillerReady: 3 }], planner: { status: 'ok', lastGoodPassAt: at.toISOString(), reason: null } };
const deps = { readWorkers: async () => workers, readSupply: async () => supply, readQuota: () => ['Quota: synthetic'], now: () => at };

async function render(state: FleetRunsDirState, now = deps.now) {
  return telegramFleetStatus({ ...deps, now, readRuns: async () => state });
}

describe('Telegram dispatcher observation freshness', () => {
  it.each(['2026-11-11T07:30:00.000Z', '2026-11-11T07:29:00.000Z'])('accepts a healthy tick at %s', async lastTick => {
    const body = await render({ ...runs, lastTick });
    expect(body).toContain('observed 1; reported 4; queue 2; target 3; held yes; tokens/1h 123');
    expect(body).toContain('dispatcher observation current');
  });

  it.each([
    ['expired', '2026-11-11T07:28:59.999Z', 'stale'],
    ['future', '2026-11-11T07:30:00.001Z', 'unknown'],
    ['invalid', 'bad source text', 'unknown'],
    ['missing', null, 'unknown'],
  ])('withholds %s dispatcher data while retaining independent sources', async (_name, lastTick, observation) => {
    const body = await render({ ...runs, lastTick });
    expect(body).toContain('observed 1; reported unavailable; queue unavailable; target unavailable; held unavailable; tokens/1h 123');
    expect(body).toContain(`dispatcher observation ${observation}`);
    expect(body).toContain('Supply: devin 2 phantom / 3 filler');
    expect(body).toContain('Planner: last good pass');
    expect(body).toContain('Quota: synthetic');
    expect(body).not.toContain('bad source text');
  });

  it('withholds valid-looking data from a degraded status source without suppressing metrics', async () => {
    const body = await render({ ...runs, sources: { ...runs.sources, status: 'degraded' } });
    expect(body).toContain('observed 1; reported unavailable; queue unavailable; target unavailable; held unavailable; tokens/1h 123');
    expect(body).toContain('dispatcher observation unknown');
  });

  it.each([
    ['invalid', () => new Date(NaN)],
    ['throwing', () => { throw new Error('private clock error'); }],
  ])('contains a %s clock failure', async (_name, now) => {
    const body = await render(runs, now);
    expect(body).toContain('Fleet status at unavailable');
    expect(body).toContain('observed 1; reported unavailable; queue unavailable; target unavailable; held unavailable; tokens/1h 123');
    expect(body).toContain('dispatcher observation unknown');
    expect(body).toContain('Quota: synthetic');
    expect(body).toContain('Supply: devin 2 phantom / 3 filler');
    expect(body).not.toContain('private clock error');
  });
});
