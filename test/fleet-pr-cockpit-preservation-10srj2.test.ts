import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetPrCockpit } from '../src/cli/fleet-pr-cockpit.js';
import { writeCache } from '../src/core/merge-cockpit.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

describe('fleet pr cockpit preservation', () => {
  it('uses offline cache without GitHub and reports missing and stale observations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-cockpit-'));
    const path = join(dir, 'cache.json');
    const lines: string[] = [];
    let calls = 0;
    const deps = { path, now: () => new Date('2026-01-01T00:10:00Z'), log: (s: string) => lines.push(s), error: (s: string) => lines.push(s), gh: async () => { calls++; throw new Error('offline'); } };
    try {
      expect(await cmdFleetPrCockpit(['--repo', 'ashlrai/phantom', '--offline', '--json'], deps)).toBe(1);
      expect(JSON.parse(lines.pop()!).repos[0].source).toBe('unavailable');
      await writeCache(path, { version: 1, snapshots: [{ repo: 'ashlrai/phantom', observedAt: '2026-01-01T00:00:00Z', prs: [] }] });
      expect(await cmdFleetPrCockpit(['--repo', 'ashlrai/phantom', '--offline', '--json'], deps)).toBe(0);
      expect(JSON.parse(lines.pop()!).repos[0].source).toBe('stale');
      expect(calls).toBe(0);
      expect(await cmdFleetPrCockpit(['--repo', 'ashlrai/phantom', '--refresh', '--json'], deps)).toBe(0);
      expect(JSON.parse(lines.pop()!).repos[0].source).toBe('stale');
      expect(calls).toBe(1);
      expect(await cmdFleetPrCockpit(['--repo'], deps)).toBe(2);
      expect(calls).toBe(1);
      expect(resolveFleetSubcommand('pr-cockpit')).toEqual({ module: './fleet-pr-cockpit.js', exportName: 'cmdFleetPrCockpit' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
