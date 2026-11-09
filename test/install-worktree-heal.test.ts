import { describe, expect, it, vi } from 'vitest';
import { healDonor, healWorktree } from '../scripts/worktree-install.mjs';

const verbOf = (call: unknown[]) => (call[1] as string[]).find((a) => a === 'wt-deps' || a === 'tsc-warm');

describe('worktree heal after install', () => {
  it('runs wt-deps then tsc-warm, each with --from donor and --apply', async () => {
    const exec = vi.fn(async () => ({ stdout: '' }));
    const out = await healWorktree('/wt/a', { exec, env: { PHANTOM_WT_DONOR: '/donor' }, stat: async () => ({}), log: vi.fn() });
    expect(exec.mock.calls.map(verbOf)).toEqual(['wt-deps', 'tsc-warm']);
    for (const call of exec.mock.calls) {
      const args = call[1] as string[];
      expect(args[args.indexOf('--from') + 1]).toBe('/donor');
      expect(args).toContain('--apply');
    }
    expect(out.steps).toEqual([{ verb: 'wt-deps', ok: true }, { verb: 'tsc-warm', ok: true }]);
  });

  it('never throws: a failing step logs one line and the next step still runs', async () => {
    const exec = vi.fn(async (_c: string, args: string[]) => {
      if (args.includes('wt-deps')) throw Object.assign(new Error('secret-token'), { cmd: 'x' });
      return { stdout: '' };
    });
    const log = vi.fn();
    const out = await healWorktree('/wt/a', { exec, env: { PHANTOM_WT_DONOR: '/donor' }, stat: async () => ({}), log });
    expect(out.steps).toEqual([{ verb: 'wt-deps', ok: false }, { verb: 'tsc-warm', ok: true }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain('secret-token');
    const both = vi.fn(async () => { throw new Error('boom'); });
    const log2 = vi.fn();
    await expect(healWorktree('/wt/a', { exec: both, env: { PHANTOM_WT_DONOR: '/d' }, stat: async () => ({}), log: log2 })).resolves.toBeTruthy();
    expect(log2).toHaveBeenCalledTimes(2);
  });

  it('skips quietly when no donor exists, and defaults to the guardian sibling', async () => {
    const exec = vi.fn();
    const missing = async () => { throw new Error('ENOENT'); };
    expect(await healWorktree('/wt/a', { exec, env: {}, stat: missing, log: vi.fn() })).toEqual({ donor: null, steps: [] });
    expect(exec).not.toHaveBeenCalled();
    expect(await healDonor({ env: {}, home: '/h', stat: async () => ({}) })).toBe('/h/Projects/ashlrai/wt/guardian-phantom');
  });
});
