import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReadySupply } from './fleet-ready-supply.js';
import type { ReadySupplyV1 } from '../core/fleet/ready-supply.js';

const sample: ReadySupplyV1 = {
  v: 1, generatedAt: '2026-11-01T00:00:00.000Z', sourceState: 'healthy', rows: 3, dropped: 0,
  lanes: [{ lane: 'codex-personal', phxReady: 1, phxParked: 0, fillerReady: 1, fillerParked: 1, oldestPhxId: 'RQ-PHX-FIRST' }],
  totals: { phxReady: 1, phxParked: 0, fillerReady: 1, fillerParked: 1 },
};
afterEach(() => vi.restoreAllMocks());

describe('fleet ready-supply', () => {
  it('prints the human report and passes options to the reader', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue(sample);
    const now = () => new Date(0);
    expect(await cmdFleetReadySupply(['--runs-dir', '/tmp/runs'], { read, now })).toBe(0);
    expect(read).toHaveBeenCalledWith({ runsDir: '/tmp/runs', now });
    expect(log).toHaveBeenCalledWith('codex-personal  phantom 1 ready (next RQ-PHX-FIRST), 0 parked; filler 1 ready, 1 parked\ntotal  phantom 1 ready, 0 parked; filler 1 ready, 1 parked\nsource: healthy');
  });

  it('prints sanitized JSON and reports degraded only as failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const degraded = { ...sample, sourceState: 'degraded' as const };
    expect(await cmdFleetReadySupply(['--json'], { read: async () => degraded })).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(degraded);
    expect(await cmdFleetReadySupply([], { read: async () => ({ ...sample, sourceState: 'missing' }) })).toBe(0);
  });

  it.each([['--bogus'], ['--help', '--bogus'], ['--runs-dir'], ['--runs-dir', 'relative'], ['--json', '--json'], ['--runs-dir', '/tmp', '--runs-dir', '/tmp']])('rejects invalid arguments %j', async (...args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn();
    expect(await cmdFleetReadySupply(args, { read })).toBe(2);
    expect(error).toHaveBeenCalledWith('Usage: ashlr fleet ready-supply [--json] [--runs-dir <abs>]');
    expect(read).not.toHaveBeenCalled();
  });
});
