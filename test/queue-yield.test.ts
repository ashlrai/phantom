import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdQueue } from '../src/cli/queue.js';
import { cmdQueueYield } from '../src/cli/queue-yield.js';

const USAGE = 'Usage: phm queue yield [--since 24h] [--json]';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queue yield', () => {
  it('prints usage and exits 0 for --help and -h, directly and through phm queue', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const flag of ['--help', '-h']) {
      expect(await cmdQueueYield([flag])).toBe(0);
      expect(await cmdQueue(['yield', flag])).toBe(0);
    }
    expect(log).toHaveBeenCalledWith(USAGE);
    expect(err).not.toHaveBeenCalled();
  });

  it('rejects unknown flags with usage and exit 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdQueueYield(['--bogus'])).toBe(2);
    expect(err).toHaveBeenCalledWith(USAGE);
  });
});
