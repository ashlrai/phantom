import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from '../../../data/client.js';
import { enrolledRepos, readRepoBacklogs } from './repo-backlog-queries.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const root = (nameWithOwner: string | null, state = 'github') => ({ path: `/x/${nameWithOwner}`, name: 'x', remote: { state, nameWithOwner, defaultBranch: 'main' } });
const read = (items: { s: string; at: string | null }[]) => ({
  v: 1, repo: 'x', generatedAt: '', source: 'ok',
  items: items.map((item, i) => ({ number: i + 1, mergeStateStatus: item.s, updatedAt: item.at })),
  counts: { mergeState: items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.s]: (acc[item.s] ?? 0) + 1 }), {}) },
});
beforeEach(() => { vi.mocked(apiGet).mockReset(); });

it('collects distinct github owner/name strings, capped at 12', () => {
  expect(enrolledRepos({ observedAt: '', repos: [root('Example-Org/Alpha'), root('example-org/alpha'), root(null, 'not-github'), root('../etc/passwd'), root('example-org/beta')] } as never))
    .toEqual(['example-org/alpha', 'example-org/beta']);
  const many = Array.from({ length: 20 }, (_, i) => root(`example-org/r${i}`));
  expect(enrolledRepos({ observedAt: '', repos: many } as never)).toHaveLength(12);
});

it('maps ok, 404 and 503 repos and requests only index names', async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === '/api/verse/github') return { observedAt: '', repos: [root('example-org/alpha'), root('example-org/beta'), root('example-org/gamma')] };
    if (path.endsWith('example-org%2Falpha')) return read([{ s: 'DIRTY', at: '2026-11-09T10:00:00Z' }, { s: 'DIRTY', at: '2026-11-08T10:00:00Z' }, { s: 'BEHIND', at: null }, { s: 'CLEAN', at: null }]);
    if (path.endsWith('example-org%2Fbeta')) throw new ApiError('missing', 404, path);
    throw new ApiError('gh failed', 503, path);
  });
  const result = await readRepoBacklogs();
  expect(result).toEqual([
    { repo: 'example-org/alpha', state: 'ok', open: 4, dirty: 2, behind: 1, clean: 1, oldestDirtyAt: '2026-11-08T10:00:00Z' },
    expect.objectContaining({ repo: 'example-org/beta', state: 'not-enrolled' }),
    expect.objectContaining({ repo: 'example-org/gamma', state: 'unavailable' }),
  ]);
  expect(vi.mocked(apiGet).mock.calls.map(call => call[0]).sort()).toEqual([
    '/api/verse/github',
    '/api/verse/github/fleet-backlog?repo=example-org%2Falpha',
    '/api/verse/github/fleet-backlog?repo=example-org%2Fbeta',
    '/api/verse/github/fleet-backlog?repo=example-org%2Fgamma',
  ]);
});

it('treats a gh-failed 200 body as unavailable, not empty', async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) => path === '/api/verse/github'
    ? { observedAt: '', repos: [root('example-org/alpha')] } : { ...read([]), source: 'gh-failed' });
  expect((await readRepoBacklogs())[0]!.state).toBe('unavailable');
});

it('keeps at most 3 reads in flight and shares the abort signal', async () => {
  let live = 0, peak = 0;
  const signal = new AbortController().signal;
  const seen: (AbortSignal | undefined)[] = [];
  vi.mocked(apiGet).mockImplementation(async (path: string, sig?: AbortSignal) => {
    seen.push(sig);
    if (path === '/api/verse/github') return { observedAt: '', repos: Array.from({ length: 8 }, (_, i) => root(`example-org/r${i}`)) };
    live++; peak = Math.max(peak, live);
    await new Promise(resolve => setTimeout(resolve, 5));
    live--;
    return read([]);
  });
  expect(await readRepoBacklogs(signal)).toHaveLength(8);
  expect(peak).toBe(3);
  expect(seen.every(sig => sig === signal)).toBe(true);
});

it('rethrows when aborted instead of reporting unavailable', async () => {
  const controller = new AbortController();
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === '/api/verse/github') return { observedAt: '', repos: [root('example-org/alpha')] };
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  await expect(readRepoBacklogs(controller.signal)).rejects.toThrow('aborted');
});
