import { describe, expect, it, vi } from 'vitest';

const usage = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock('../src/cli/fleet-usage.js', () => ({ cmdFleetUsage: usage }));
import { cmdFleet } from '../src/cli/fleet.js';

describe('fleet usage dispatch', () => {
  it('forwards usage arguments to the strict usage parser', async () => {
    const args = ['add', 'grok-ultra-weekly', '63', '--at', '2026-10-26T13:15:00Z'];
    expect(await cmdFleet(['usage', ...args])).toBe(0);
    expect(usage).toHaveBeenCalledWith(args);
  });

  it('shows help without invoking the usage command', async () => {
    usage.mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleet(['usage', '--help'])).toBe(0);
      expect(log.mock.calls.some(([line]) => String(line).includes('fleet usage'))).toBe(true);
      expect(usage).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
