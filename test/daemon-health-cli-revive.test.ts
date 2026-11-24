import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  config: vi.fn(),
  inventory: vi.fn(),
  health: vi.fn(),
  diagnose: vi.fn(() => [{ id: 'claude', engine: 'claude', reason: 'unavailable', binaryOnPath: false }]),
}));
vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: effects.config }));
vi.mock('../src/core/generative/invent.js', () => ({ listFrontierClients: effects.inventory }));
vi.mock('../src/core/daemon/guard-health.js', () => ({ readDaemonHealth: effects.health, diagnoseFrontierClients: effects.diagnose }));
import { cmdDaemon } from '../src/cli/daemon.js';

beforeEach(() => {
  effects.config.mockReturnValue({});
  effects.inventory.mockReturnValue([
    { id: 'codex-primary', engine: 'codex', model: 'gpt-5.4', available: true, reason: 'resolved' },
    { id: 'claude', engine: 'claude', model: null, available: false, reason: 'unavailable' },
  ]);
  effects.health.mockImplementation((frontierClientsResolved) => ({
    schemaVersion: 1, alive: true, lastTickAt: null, lastLogWriteAt: null,
    frontierClientsResolved, healthy: frontierClientsResolved !== null,
    supervisor: { restartRecommended: false, reason: 'healthy' },
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('daemon health CLI', () => {
  it('bounds a hanging inventory probe and keeps its inventory unknown', async () => {
    vi.useFakeTimers();
    effects.inventory.mockReturnValue(new Promise(() => {}));
    const result = cmdDaemon(['health', '--json']);
    await vi.waitFor(() => expect(effects.inventory).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBe(1);
    expect(effects.health).toHaveBeenCalledWith(null, {}, {
      unavailable: [], error: 'frontier probe timed out after 30 s',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prints each unavailable client cause in human output', async () => {
    effects.health.mockReturnValue({ healthy: false, alive: true,
      frontierClientsUnavailable: [{ id: 'claude', cause: 'binary-not-found', binaryPath: null }],
      supervisor: { reason: 'frontier-unavailable', restartRecommended: false } });
    expect(await cmdDaemon(['health'])).toBe(1);
    expect(console.log).toHaveBeenCalledWith('Frontier claude: binary-not-found');
  });
  it('emits one JSON object using read-only config and only resolved client metadata', async () => {
    expect(await cmdDaemon(['health', '--json'])).toBe(0);
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
    expect(output.frontierClientsResolved).toEqual([{ id: 'codex-primary', engine: 'codex', model: 'gpt-5.4' }]);
    expect(effects.config).toHaveBeenCalledOnce();
    expect(effects.health).toHaveBeenCalledWith(expect.any(Array), {}, {
      unavailable: [{ id: 'claude', engine: 'claude', reason: 'unavailable', binaryOnPath: false }],
    });
  });

  it('reports unknown inventory and exits nonzero on config failure without exposing the error', async () => {
    effects.config.mockImplementation(() => { throw new Error('sensitive configuration'); });
    expect(await cmdDaemon(['health', '--json'])).toBe(1);
    expect(effects.health).toHaveBeenCalledWith(null, {}, { unavailable: [], error: 'config or frontier inventory unreadable' });
    expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).not.toContain('sensitive');
    expect(effects.inventory).not.toHaveBeenCalled();
  });

  it('prints help without loading config or probing health', async () => {
    expect(await cmdDaemon(['health', '--help'])).toBe(0);
    expect(effects.config).not.toHaveBeenCalled();
    expect(effects.health).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Usage: ashlr daemon health [--json]');
  });

  it('rejects restart and mutation flags before probing', async () => {
    expect(await cmdDaemon(['health', '--restart'])).not.toBe(0);
    expect(effects.config).not.toHaveBeenCalled();
    expect(effects.health).not.toHaveBeenCalled();
  });

  it('returns nonzero for an unhealthy report', async () => {
    effects.health.mockReturnValue({ healthy: false, alive: false, supervisor: { restartRecommended: true, reason: 'dead' } });
    expect(await cmdDaemon(['health', '--json'])).toBe(1);
  });
});
