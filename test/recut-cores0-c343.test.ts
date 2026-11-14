import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetPrCockpit } from '../src/cli/fleet-pr-cockpit.js';
import { readCache } from '../src/core/merge-cockpit.js';

const node = (number: number) => ({
  number,
  title: 'recut',
  body: '',
  mergeable: 'MERGEABLE',
  autoMergeRequest: { enabledAt: '2026-01-01T00:00:00Z' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
});

const page = (nodes: unknown[]) => JSON.stringify({
  data: {
    rateLimit: { remaining: 99 },
    repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
  },
});

describe('recut cores0 c343: fleet pr-cockpit', () => {
  it('fetches once, persists a private cache, and serves --offline from it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recut-c343-'));
    try {
      const path = join(dir, 'cache.json');
      let calls = 0;
      const lines: string[] = [];
      const deps = {
        path,
        now: () => new Date('2026-01-01T00:00:00Z'),
        log: (s: string) => lines.push(s),
        error: (s: string) => lines.push(s),
        gh: async (_args: string[]) => { calls += 1; return page([node(1), node(2)]); },
      };
      expect(await cmdFleetPrCockpit(['--repo', 'ashlrai/phantom', '--json'], deps)).toBe(0);
      expect(calls).toBe(1);
      const live = JSON.parse(lines.at(-1)!);
      expect(live.repos[0].source).toBe('live');
      expect(live.repos[0].counts).toMatchObject({ open: 2, green: 2, autoMerge: 2 });
      const cache = await readCache(path);
      expect(cache.snapshots.map((s) => s.repo)).toEqual(['ashlrai/phantom']);
      expect(cache.snapshots[0]!.prs).toHaveLength(2);
      expect(await cmdFleetPrCockpit(['--repo', 'ashlrai/phantom', '--offline', '--json'], deps)).toBe(0);
      expect(calls).toBe(1);
      const offline = JSON.parse(lines.at(-1)!);
      expect(offline.repos[0].source).toBe('cache');
      expect(offline.repos[0].counts.open).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
