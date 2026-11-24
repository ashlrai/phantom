import { describe, expect, it, vi } from 'vitest';
import { cmdFleetLanded } from '../src/cli/fleet-landed.js';
import { readLandedFromGit } from '../src/core/fleet/landed-from-git.js';

describe('fleet landed requested IDs', () => {
  it('reports exact matches, window absence, order and deduplication', async () => {
    const report = readLandedFromGit({ sinceHours: 48, git: args => args[0] === 'log'
      ? 'abc\x1f2026-01-01T00:00:00Z\x1fbridge: RQ-ABC\x1e' : '' });
    const read = vi.fn(() => report);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLanded(['--job', 'RQ-AB', '--since', '2d', '--json', '--job', 'RQ-ABC', '--job', 'RQ-AB'], { read })).toBe(0);
    expect(read).toHaveBeenCalledWith(48);
    expect(JSON.parse(String(log.mock.calls[0]![0])).results).toEqual([
      { id: 'RQ-AB', state: 'not-observed-in-window' },
      { id: 'RQ-ABC', repo: 'phantom', sha: 'abc', at: '2026-01-01T00:00:00Z', state: 'landed' },
    ]);
    log.mockRestore();
  });

  it('keeps positive evidence and marks missing IDs unknown on partial or total failure', async () => {
    for (const partial of [true, false]) {
      const observed = readLandedFromGit({ repos: [{ name: 'a', cwd: 'a' }, { name: 'b', cwd: 'b' }], git: (args, cwd) => {
        if (args[0] === 'fetch' && (!partial || cwd === 'b')) throw new Error('offline');
        return args[0] === 'log' ? 'abc\x1f2026-01-01\x1fRQ-ABC\x1e' : '';
      } });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdFleetLanded(['--job', 'RQ-ABC', '--job', 'RQ-AB'], { read: () => observed })).toBe(1);
      expect(log.mock.calls.map(call => call[0]).join('\n')).toContain('RQ-AB: unknown');
      expect(log.mock.calls.map(call => call[0]).join('\n')).toContain(partial ? 'RQ-ABC: landed a abc' : 'RQ-ABC: unknown');
      log.mockRestore();
    }
  });

  it('rejects malformed operands before reading and preserves unfiltered output', async () => {
    const read = vi.fn(() => readLandedFromGit({ git: () => '' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--job'], ['--job', '--json'], ['--job', '--help'], ['--job', 'RQ-AB!']]) expect(await cmdFleetLanded(args, { read })).toBe(2);
    expect(read).not.toHaveBeenCalled();
    error.mockRestore();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLanded(['--json'], { read })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(read.mock.results[0]!.value);
    log.mockRestore();
  });
});
