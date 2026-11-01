import { expect, it } from 'vitest';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import { dropJobPreflight, hotFileHits } from './drop-job-preflight.js';

const hotFiles = [
  { path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 9 },
  { path: 'docs/fleet.md', dirtyPrs: 3, openPrs: 4 },
];

it('matches a hot file named as a whole token', () => {
  expect(hotFileHits('Update src/cli/fleet.ts carefully', hotFiles)).toEqual([
    { path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 9 },
  ]);
});

it('ignores a path that only appears inside a longer token', () => {
  expect(hotFileHits('Edit src/cli/fleet-verbs.ts and src/cli/fleet.ts.bak', hotFiles)).toEqual([]);
  expect(hotFileHits('Touch src/cli/fleet.tsx today', hotFiles)).toEqual([]);
});

it('matches inside quotes, backticks and parentheses', () => {
  expect(hotFileHits('Only touch `src/cli/fleet.ts` please', hotFiles)).toHaveLength(1);
  expect(hotFileHits("Rewrite 'src/cli/fleet.ts' cleanly", hotFiles)).toHaveLength(1);
  expect(hotFileHits('See "src/cli/fleet.ts" first', hotFiles)).toHaveLength(1);
  expect(hotFileHits('Merge order (src/cli/fleet.ts) matters', hotFiles)).toHaveLength(1);
});

it('returns every hit sorted by dirtyPrs desc then path', () => {
  expect(hotFileHits('docs/fleet.md and src/cli/fleet.ts both move', hotFiles)).toEqual([
    { path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 9 },
    { path: 'docs/fleet.md', dirtyPrs: 3, openPrs: 4 },
  ]);
  expect(hotFileHits('docs/fleet.md and src/cli/fleet.ts both move', [...hotFiles].reverse())).toEqual([
    { path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 9 },
    { path: 'docs/fleet.md', dirtyPrs: 3, openPrs: 4 },
  ]);
});

it('returns [] for an empty hot-file list or a clean body', () => {
  expect(hotFileHits('Update src/cli/fleet.ts carefully', [])).toEqual([]);
  expect(hotFileHits('Update src/cli/other.ts carefully', hotFiles)).toEqual([]);
  expect(hotFileHits('', hotFiles)).toEqual([]);
});

it('folds hits into the preflight result without touching warnings', () => {
  const backlog: MergeBacklogReadV1 = {
    v: 1, repo: 'fake/repo', generatedAt: '', source: 'ok',
    counts: { mergeState: {}, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } },
    hotFiles: [...hotFiles, { path: '.github/workflows/ci.yml', dirtyPrs: 2, openPrs: 2 }],
    items: Array.from({ length: 8 }, (_, i) => ({ number: 100 + i, files: ['src/cli/fleet.ts'], mergeStateStatus: 'DIRTY', title: '', headRef: '', updatedAt: null, isDraft: false, job: null, classification: { class: 'conflicted', work: 'refix', reason: 'fake' }, suggestedAction: 'recut' })),
  };
  const result = dropJobPreflight('Update .github/workflows/ci.yml and src/cli/fleet.ts', backlog);
  expect(result.hotFiles).toEqual([
    { path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 9 },
    { path: '.github/workflows/ci.yml', dirtyPrs: 2, openPrs: 2 },
  ]);
  expect(result.warnings).toEqual([{ path: 'src/cli/fleet.ts', dirtyPrs: 8, prNumbers: [100, 101, 102, 103, 104] }]);
  expect(dropJobPreflight('Update src/cli/fleet.ts', { ...backlog, source: 'gh-failed' })).toEqual({ warnings: [], hotFiles: [] });
});
