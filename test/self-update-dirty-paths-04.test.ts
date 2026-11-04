/** RQ-PHX-UPDATEDIRTYPATHS04: the status probe surfaces which paths block a fast-forward. */
import { describe, expect, it } from 'vitest';
import { readSelfUpdateStatus, type SelfUpdateDeps } from '../src/core/verse/self-update-status.js';
import { aboutUpdateLines } from '../src/web-ui/routes/verse/sections/about-update-model.js';
import type { UpdateServerStatus } from '../src/web-ui/routes/verse/sections/update-status-queries.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function fixture(porcelain: string | null, over: SelfUpdateDeps = {}): SelfUpdateDeps {
  return {
    repoRoot: () => '/fixture', readPackageVersion: () => '1.2.3',
    statFetchHead: () => new Date(NOW - 1000), now: () => NOW,
    runGit: async (args) => {
      if (args[0] === 'status') return porcelain === null ? { code: 1, stdout: '/private/path' } : { code: 0, stdout: porcelain };
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t3' };
      if (args[0] === 'show' && args[1] === 'origin/master:package.json') return { code: 0, stdout: '{"version":"1.2.4"}' };
      if (args[0] === 'show') return { code: 0, stdout: '2026-10-30T12:00:00Z' };
      if (args[0] === 'log') return { code: 0, stdout: 'behind one\nbehind two' };
      if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'master' };
      return { code: 0, stdout: 'a'.repeat(40) };
    },
    ...over,
  };
}

const TEN_DIRTY = [
  ' M src/a.ts', ' M src/b.ts', '?? src/c.ts', ' M src/d.ts',
  'R  src/old-name.ts -> src/new-name.ts', ' M "src/dir with spaces/e.ts"',
  ' M src/f.ts', ' M src/g.ts', ' M src/h.ts', '?? src/i.ts',
].join('\n');

const baseStatus: UpdateServerStatus = {
  v: 1, sourceState: 'healthy', installedVersion: '3.30.0', headSha: 'abcdef123456',
  headAt: '2026-10-31T10:00:00Z', originSha: '123456789abc', branch: 'master',
  behind: 3, ahead: 0, dirty: true, lastFetchAt: '2026-10-31T11:55:00Z',
  processStartedAt: '2026-10-30T12:00:00Z', uptimeSeconds: 60, canFastForward: false,
};

describe('self update dirty paths', () => {
  it('reports an empty list and zero count for a clean tree', async () => {
    const status = await readSelfUpdateStatus(fixture(''));
    expect(status).toMatchObject({ dirty: false, dirtyPaths: [], dirtyCount: 0, canFastForward: true });
  });
  it('parses ten porcelain entries down to eight plain paths with the full count', async () => {
    const status = await readSelfUpdateStatus(fixture(TEN_DIRTY));
    expect(status.dirty).toBe(true);
    expect(status.dirtyCount).toBe(10);
    expect(status.dirtyPaths).toEqual([
      'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts',
      'src/new-name.ts', 'src/dir with spaces/e.ts', 'src/f.ts', 'src/g.ts',
    ]);
    expect(JSON.stringify(status)).not.toContain('/fixture');
  });
  it('keeps the quoted destination of a rename', async () => {
    const status = await readSelfUpdateStatus(fixture('R  src/old.ts -> "src/new dir/new.ts"'));
    expect(status.dirtyPaths).toEqual(['src/new dir/new.ts']);
  });
  it('scrubs secret-shaped file names and caps each path at 200 chars', async () => {
    const status = await readSelfUpdateStatus(fixture(
      ` M dir/sk-${'A'.repeat(20)}.txt\n M ${'x'.repeat(250)}`,
    ));
    expect(status.dirtyPaths).toEqual(['dir/[REDACTED].txt', 'x'.repeat(200)]);
  });
  it('leaves both fields null when the status probe fails', async () => {
    const status = await readSelfUpdateStatus(fixture(null));
    expect(status).toMatchObject({ dirty: null, dirtyPaths: null, dirtyCount: null, sourceState: 'degraded' });
    expect(JSON.stringify(status)).not.toContain('/private/path');
  });
});

describe('about model local changes row', () => {
  it('shows the first three blocking paths and the overflow count', async () => {
    const status = await readSelfUpdateStatus(fixture(TEN_DIRTY));
    const model = aboutUpdateLines(status, NOW);
    expect(model.headline).toBe('3 commits behind origin/master · Needs a manual update (local changes)');
    expect(model.rows).toContainEqual({ label: 'Local changes', value: 'src/a.ts, src/b.ts, src/c.ts +7 more' });
  });
  it('omits the overflow suffix at three paths or fewer', () => {
    const model = aboutUpdateLines({ ...baseStatus, dirtyPaths: ['a.ts', 'b.ts', 'c.ts'], dirtyCount: 3 } as UpdateServerStatus, NOW);
    expect(model.rows).toContainEqual({ label: 'Local changes', value: 'a.ts, b.ts, c.ts' });
  });
  it('keeps the headline but no row when the server predates dirtyPaths', () => {
    const model = aboutUpdateLines({ ...baseStatus } as UpdateServerStatus, NOW);
    expect(model.headline).toBe('3 commits behind origin/master · Needs a manual update (local changes)');
    expect(model.rows.find((r) => r.label === 'Local changes')).toBeUndefined();
  });
  it('adds no row for a clean tree', () => {
    const model = aboutUpdateLines({ ...baseStatus, behind: 0, dirty: false } as UpdateServerStatus, NOW);
    expect(model.rows.find((r) => r.label === 'Local changes')).toBeUndefined();
  });
});
