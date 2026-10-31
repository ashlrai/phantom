import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inputHash, treeHash } from '../src/core/knowledge/wiki/plan.js';
import { readRepoText, scanRepo, type RepoScan } from '../src/core/knowledge/wiki/scan.js';
import { statusFromManifest } from '../src/core/knowledge/wiki/status.js';
import { readWikiSteering, type WikiSteering } from '../src/core/knowledge/wiki/steering.js';
import type { WikiManifest, WikiPageMeta } from '../src/core/knowledge/wiki/types.js';

vi.mock('../src/core/knowledge/wiki/scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/knowledge/wiki/scan.js')>()),
  scanRepo: vi.fn(),
  readRepoText: vi.fn(),
}));
vi.mock('../src/core/knowledge/wiki/steering.js', () => ({ readWikiSteering: vi.fn() }));

const repo = '/fake/repo';
const generatedAt = '2026-01-01T00:00:00.000Z';
const storedCommit = 'a'.repeat(40);
const currentCommit = 'b'.repeat(40);
const files = [{ rel: 'src/index.ts', size: 10, blob: 'original-blob' }];
const steering: WikiSteering = {
  include: [], exclude: [], focus: [], notes: [], ignorePaths: ['ignored'], pages: [],
  localOnly: true, devinDefinesPages: false, sources: [], hash: 'steering-hash',
};

function manifestFor(listedFiles: RepoScan['files'] = files): WikiManifest {
  const ctx = {
    blobs: new Map(listedFiles.map((file) => [file.rel, file.blob])),
    tree: treeHash(listedFiles.map((file) => file.rel)),
    steering: steering.hash,
  };
  const pages: WikiPageMeta[] = [
    {
      id: 'overview', title: 'Overview', kind: 'overview', purpose: 'Overview',
      specHash: 'overview-spec', inputHash: '', inputs: listedFiles.map((file) => file.rel),
      pseudo: ['@steering'], commit: storedCommit, generatedAt, model: 'facts-only',
      citations: 0, droppedCitations: 0,
    },
    {
      id: 'modules', title: 'Modules', kind: 'modules', purpose: 'Modules', parent: 'overview',
      specHash: 'modules-spec', inputHash: '', inputs: [], pseudo: ['@tree', '@steering'],
      commit: storedCommit, generatedAt, model: 'fake:model', citations: 0, droppedCitations: 0,
    },
  ];
  for (const page of pages) page.inputHash = inputHash(page, ctx);
  return {
    version: 1, generator: 1, repo, repoName: 'repo', key: 'fake-key', commit: storedCommit,
    generatedAt, steeringHash: steering.hash, pages, pending: [],
    lastRun: {
      startedAt: generatedAt, finishedAt: generatedAt, generated: 2, skippedFresh: 0,
      deferred: 0, failed: 0, estimatedTokens: 0, engine: 'fake', budgetStop: null,
    },
  };
}

function scan(overrides: Partial<RepoScan> = {}): RepoScan {
  return { repo, name: 'repo', head: currentCommit, git: true, files, truncated: false, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readWikiSteering).mockResolvedValue(steering);
  vi.mocked(scanRepo).mockResolvedValue(scan());
});

describe('wiki status with incomplete scans', () => {
  it('keeps unchanged pages fresh and preserves the public status and provenance', async () => {
    const manifest = manifestFor();
    const result = await statusFromManifest(manifest);
    expect(result).toEqual({
      repo, repoName: 'repo', key: 'fake-key', exists: true, generatedAt,
      generatedCommit: storedCommit, currentCommit,
      pages: [
        { id: 'overview', title: 'Overview', kind: 'overview', stale: false, model: 'facts-only', generatedAt },
        { id: 'modules', title: 'Modules', kind: 'modules', parent: 'overview', stale: false, model: 'fake:model', generatedAt },
      ],
      stalePages: 0, pendingPages: 0, lastRun: manifest.lastRun,
    });
    expect(readWikiSteering).toHaveBeenCalledWith(repo);
    expect(scanRepo).toHaveBeenCalledWith(repo, ['ignored']);
    expect(readRepoText).not.toHaveBeenCalled();
  });

  it.each([
    ['unreadable empty listing', { files: [], head: null, git: false, listingIncomplete: true }],
    ['incomplete matching listing', { listingIncomplete: true }],
    ['truncated matching listing', { truncated: true }],
    ['truncated empty listing', { files: [], truncated: true }],
  ])('marks all stored pages stale for an %s', async (_label, overrides) => {
    const manifest = manifestFor();
    vi.mocked(scanRepo).mockResolvedValue(scan(overrides));
    const result = await statusFromManifest(manifest);
    expect(result.exists).toBe(true);
    expect(result.pages.map((page) => page.stale)).toEqual([true, true]);
    expect(result.stalePages).toBe(2);
    expect(result.pendingPages).toBe(0);
    expect(result.generatedAt).toBe(generatedAt);
    expect(result.generatedCommit).toBe(storedCommit);
    expect(result.currentCommit).toBe(overrides.head === null ? null : currentCommit);
    expect(result.lastRun).toEqual(manifest.lastRun);
    expect(readRepoText).not.toHaveBeenCalled();
  });

  it('retains fresh pages for a successful empty listing', async () => {
    vi.mocked(scanRepo).mockResolvedValue(scan({ files: [], head: null, git: false }));
    const result = await statusFromManifest(manifestFor([]));
    expect(result.exists).toBe(true);
    expect(result.currentCommit).toBeNull();
    expect(result.pages.map((page) => page.stale)).toEqual([false, false]);
    expect(result.stalePages).toBe(0);
    expect(readRepoText).not.toHaveBeenCalled();
  });

  it('marks pending pages stale even when their hashes match', async () => {
    const manifest = manifestFor();
    manifest.pending = ['modules', 'not-yet-stored'];
    const result = await statusFromManifest(manifest);
    expect(result.pages.map((page) => page.stale)).toEqual([false, true]);
    expect(result.stalePages).toBe(1);
    expect(result.pendingPages).toBe(2);
    expect(readRepoText).not.toHaveBeenCalled();
  });

  it('marks only the affected page stale when a blob changes in a complete listing', async () => {
    vi.mocked(scanRepo).mockResolvedValue(scan({ files: [{ ...files[0]!, blob: 'changed-blob' }] }));
    const result = await statusFromManifest(manifestFor());
    expect(result.pages.map((page) => page.stale)).toEqual([true, false]);
    expect(result.stalePages).toBe(1);
    expect(result.generatedCommit).toBe(storedCommit);
    expect(result.currentCommit).toBe(currentCommit);
    expect(readRepoText).not.toHaveBeenCalled();
  });
});
