import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLeaderHealth, readFleetLeaderHealth } from '../src/cli/fleet-leader-health.js';

const log = (outcomes: string[]) => outcomes.map(rc => `2026-11-02 08:00:00 OPUS-LEADER ${rc}`).join('\n');
const options = (outcomes = ['rc=1']) => ({ now: new Date(2026, 10, 2, 12).getTime(), readEvents: async () => log(outcomes) });
afterEach(() => vi.restoreAllMocks());

describe('fleet leader failure cause', () => {
  it.each([
    ['OAuth session expired. Please sign in.\nprivate second line', 'Claude sign-in expired: run claude login'],
    ['Service unavailable\r\nsecond line', 'Service unavailable'],
    ['x'.repeat(200), 'x'.repeat(160)],
    ['', null],
  ])('explains only the first output line (%s)', async (output, cause) => {
    const reader = vi.fn(async () => output);
    expect(await readFleetLeaderHealth({ ...options(), readLatestOutput: reader })).toMatchObject({ cause });
    expect(reader).toHaveBeenCalledWith(expect.stringMatching(/\.ashlr-runs\/leader$/));
  });
  it.each([{ outcomes: ['rc=1', 'rc=0'] }, { outcomes: ['rc=1', 'pending'] }, { outcomes: [] }])('does not read output unless the last outcome failed (%j)', async ({ outcomes }) => {
    const reader = vi.fn(async () => 'old failure');
    expect((await readFleetLeaderHealth({ ...options(outcomes), readLatestOutput: reader })).cause).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
  it('keeps health evidence when output is unreadable', async () => {
    expect(await readFleetLeaderHealth({ ...options(), readLatestOutput: async () => { throw new Error('unreadable'); } }))
      .toMatchObject({ cause: null, consecutiveFailures: 1, source: 'read' });
  });
  it('selects the newest matching fixture file by modification time', async () => {
    const home = await mkdtemp(join(tmpdir(), 'leader-cause-'));
    vi.spyOn(await import('node:os'), 'homedir').mockReturnValue(home);
    const directory = join(home, '.ashlr-runs', 'leader');
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'opus-run-z.out'), 'old failure');
      await utimes(join(directory, 'opus-run-z.out'), 1, 1);
      await writeFile(join(directory, 'opus-run-a.out'), 'OAuth session expired\nignored');
      await writeFile(join(directory, 'other.out'), 'unrelated');
      const print = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdFleetLeaderHealth([], options(['rc=1', 'rc=1']))).toBe(1);
      expect(print).toHaveBeenCalledWith(expect.stringContaining('Cause: Claude sign-in expired: run claude login'));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
