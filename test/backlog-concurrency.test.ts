import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKLOG_REPO_CONCURRENCY, buildBacklog } from '../src/core/portfolio/backlog.js';

const mocks = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('../src/core/portfolio/scanners.js', () => ({
  SCANNERS: [mocks.scan, async () => { throw new Error('isolated scanner error'); }],
  SCANNER_REGISTRATIONS: undefined,
}));
vi.mock('../src/core/plugins/registry.js', () => ({ getPluginScanners: async () => [] }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('bounds active repos, scans every repo and aggregates out-of-order completions deterministically', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-pool-')));
  roots.push(root);
  const repos = Array.from({ length: BACKLOG_REPO_CONCURRENCY + 2 }, (_, i) => {
    const repo = join(root, `repo-${i}`); mkdirSync(repo); return repo;
  });
  let active = 0; let peak = 0;
  const releases = new Map<string, () => void>();
  mocks.scan.mockImplementation(async (repo: string) => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => { releases.set(repo, resolve); });
    active--;
    return [{ id: repo, repo, source: 'issue', title: 'Repair parser corruption', detail: 'Handle invalid input without corrupting persisted state', value: 4, effort: 1, score: 4, tags: [], ts: '2026-01-01T00:00:00.000Z' }];
  });
  const pending = buildBacklog({ repos, persist: false, cfg: { foundry: { feedbackEnabled: false } }, listPendingProposals: () => [] });
  try {
    await vi.waitFor(() => expect(releases.size).toBe(BACKLOG_REPO_CONCURRENCY));
    for (const repo of repos.slice(0, BACKLOG_REPO_CONCURRENCY).reverse()) releases.get(repo)!();
    await vi.waitFor(() => expect(releases.size).toBe(repos.length));
  } finally { for (const release of releases.values()) release(); }
  const result = await pending;
  expect(peak).toBe(BACKLOG_REPO_CONCURRENCY);
  expect([...releases.keys()]).toEqual(repos);
  expect(result.items.map((item) => item.repo)).toEqual(repos);
});

it('handles an empty scan set', async () => {
  const result = await buildBacklog({ repos: [], persist: false });
  expect(result.items).toEqual([]);
  expect(result.observations).toEqual([]);
});
