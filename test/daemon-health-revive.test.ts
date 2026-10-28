import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonLivenessV1 } from '../src/core/daemon/liveness.js';

const probes = vi.hoisted(() => ({
  liveness: vi.fn(),
  pause: vi.fn(),
  kill: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('../src/core/daemon/liveness.js', () => ({ probeDaemonLiveness: probes.liveness }));
vi.mock('../src/core/autonomy/evidence-pack.js', () => ({ evidenceDir: vi.fn() }));
vi.mock('../src/core/daemon/state.js', () => ({
  daemonLockPath: vi.fn(), loadDaemonStateStrict: vi.fn(),
  readDaemonLockOwner: vi.fn(), readDaemonSpendGuard: vi.fn(),
}));
vi.mock('../src/core/daemon/pause.js', () => ({ readDaemonPause: probes.pause }));
vi.mock('../src/core/sandbox/policy.js', () => ({ readKillSwitch: probes.kill }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  statSync: probes.stat,
}));

import { DAEMON_LOG_STALE_MS, readDaemonHealth } from '../src/core/daemon/guard-health.js';

const nowMs = Date.parse('2026-10-26T16:00:00Z');
const clients = [{ id: 'codex-primary', engine: 'codex', model: 'gpt-5.4' }];
function liveness(alive: boolean | null = true): DaemonLivenessV1 {
  return {
    v: 1, checkedAt: new Date(nowMs).toISOString(),
    state: alive === true ? 'alive' : alive === false ? 'stale' : 'unknown',
    alive, pid: alive ? 42 : null,
    recorded: { running: true, pid: 42, startedAt: '2026-10-26T12:00:00Z', lastTickAt: '2026-10-26T15:59:00Z' },
    lock: null, activity: null, staleRecord: alive === false, reason: 'fixture',
  };
}

beforeEach(() => {
  probes.liveness.mockReturnValue(liveness());
  probes.pause.mockReturnValue({ state: 'running' });
  probes.kill.mockReturnValue({ state: 'inactive' });
  probes.stat.mockReturnValue({ isFile: () => true, mtimeMs: nowMs - 60_000 });
});

describe('daemon health and supervisor recommendation', () => {
  it('reports proven alive, tick, log metadata and resolved clients without log reads', () => {
    const report = readDaemonHealth(clients, { nowMs, platform: 'darwin' });
    expect(report).toMatchObject({
      alive: true, pid: 42, lastTickAt: '2026-10-26T15:59:00Z',
      lastLogWriteAt: '2026-10-26T15:59:00.000Z', logAgeMs: 60_000,
      logState: 'fresh', frontierClientsResolved: clients, healthy: true,
      supervisor: { restartRecommended: false, reason: 'healthy' },
    });
    expect(probes.stat.mock.calls.map(([path]) => String(path).split('/').at(-1)))
      .toEqual(['daemon.launchd.out.log', 'daemon.launchd.err.log']);
    expect(probes.stat.mock.calls.every(([path]) => !/\.codex[^/]*\/auth/.test(String(path)))).toBe(true);
  });

  it.each([
    [DAEMON_LOG_STALE_MS, false],
    [DAEMON_LOG_STALE_MS + 1, true],
  ])('recommends restart only beyond fifteen minutes (%i ms)', (age, restart) => {
    const report = readDaemonHealth(clients, { nowMs, logMtime: () => nowMs - age });
    expect(report.supervisor.restartRecommended).toBe(restart);
    expect(report.logState).toBe(restart ? 'stale' : 'fresh');
  });

  it('uses the most recent stdout or stderr write', () => {
    const report = readDaemonHealth(clients, {
      nowMs, platform: 'darwin',
      logMtime: (name) => name.includes('.out.') ? nowMs - 60_000 : nowMs - DAEMON_LOG_STALE_MS - 1,
    });
    expect(report.logState).toBe('fresh');
  });

  it('recommends restart when proven dead even if log was recently written', () => {
    probes.liveness.mockReturnValue(liveness(false));
    expect(readDaemonHealth(clients, { nowMs }).supervisor)
      .toEqual({ restartRecommended: true, reason: 'dead' });
  });

  it.each(['paused', 'unknown'] as const)('suppresses restart when pause is %s', (state) => {
    probes.pause.mockReturnValue({ state });
    probes.liveness.mockReturnValue(liveness(false));
    expect(readDaemonHealth(clients, { nowMs }).supervisor.restartRecommended).toBe(false);
  });

  it.each(['active', 'unknown'] as const)('suppresses restart when Stop is %s', (state) => {
    probes.kill.mockReturnValue({ state });
    probes.liveness.mockReturnValue(liveness(false));
    expect(readDaemonHealth(clients, { nowMs }).supervisor.restartRecommended).toBe(false);
  });

  it('suppresses restart for unproven liveness, even with stale logs', () => {
    probes.liveness.mockReturnValue(liveness(null));
    const report = readDaemonHealth(clients, { nowMs, logMtime: () => nowMs - DAEMON_LOG_STALE_MS - 1 });
    expect(report.alive).toBeNull();
    expect(report.supervisor).toEqual({ restartRecommended: false, reason: 'unknown' });
  });

  it.each([undefined, NaN, Infinity, -1, nowMs + 1])('keeps invalid log evidence unknown (%s)', (mtime) => {
    const report = readDaemonHealth(clients, { nowMs, logMtime: () => mtime });
    expect(report.logState).toBe('unknown');
    expect(report.healthy).toBe(false);
    expect(report.supervisor.restartRecommended).toBe(false);
  });

  it('does not treat missing logs as proof of a hung daemon', () => {
    const report = readDaemonHealth(clients, { nowMs, logMtime: () => null });
    expect(report.lastLogWriteAt).toBeNull();
    expect(report.logState).toBe('missing');
    expect(report.supervisor.restartRecommended).toBe(false);
  });

  it('does not turn permission failures into absence', () => {
    probes.stat.mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); });
    expect(readDaemonHealth(clients, { nowMs }).logState).toBe('unknown');
  });

  it('reports absence separately from permission failure', () => {
    probes.stat.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    expect(readDaemonHealth(clients, { nowMs }).logState).toBe('missing');
  });

  it.each([null, []])('does not claim healthy without resolved frontier clients', (inventory) => {
    const report = readDaemonHealth(inventory, { nowMs });
    expect(report.healthy).toBe(false);
    expect(report.supervisor).toEqual({
      restartRecommended: false, reason: inventory === null ? 'unknown' : 'frontier-unavailable',
    });
  });
});
