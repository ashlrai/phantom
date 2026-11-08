import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdApp } from '../src/cli/app.js';

afterEach(() => vi.restoreAllMocks());

describe('app restart refusal contract', () => {
  it('returns a machine-readable refusal instead of claiming attachment or restart', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdApp(['restart', '--json'])).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      schema: 'phantom-app-restart/v1', state: 'held', restarted: false,
      reason: 'runtime-ownership-migration-required',
      blockers: [
        'verse-sidecar-owned-by-ui',
        'interactive-sessions-and-ptys-owned-by-sidecar',
        'computer-use-workers-owned-by-ui',
        'durable-ui-checkpoint-and-reattach-not-implemented',
      ],
    });
  });

  it.each([
    ['restart'], ['restart', '--json', '--force'], ['restart', '--json', '/Applications/Phantom.app'],
    ['restart', '--json', '--stage', 'a'.repeat(32)], ['update', '--json'], ['--json', 'restart'],
  ])('rejects unsupported arguments %j without emitting a restart receipt', async (...args) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdApp(args)).toBe(2);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([[], ['help'], ['--help'], ['-h']])('documents refusal in help %j', async (...args) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdApp(args)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('held restart (exit 1)'));
  });
});
