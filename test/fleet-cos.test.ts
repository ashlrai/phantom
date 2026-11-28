import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCos } from '../src/cli/fleet-cos.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fleet cos', () => {
  it('prints fleet-scoped usage and exits 0 for --help and -h', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const flag of ['--help', '-h']) {
      expect(await cmdFleetCos([flag])).toBe(0);
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: phm fleet cos ask'));
    expect(err).not.toHaveBeenCalled();
  });
});
