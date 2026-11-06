import { expect, it } from 'vitest';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import type { LaneTargetRow } from '../ops/lane-targets-model.js';
import { extractPaths, hotFileWarnings, laneLine, type PreflightTargets } from './drop-job-preflight.js';

const item = (number: number, files: string[], mergeStateStatus = 'DIRTY'): MergeBacklogReadV1['items'][number] => ({
  number, files, mergeStateStatus, title: '', headRef: '', updatedAt: null, isDraft: false, job: null,
  classification: { class: 'conflicted', work: 'refix', reason: 'fake' }, suggestedAction: 'recut',
});
const backlog: MergeBacklogReadV1 = {
  v: 1, repo: 'fake/repo', generatedAt: '', source: 'ok',
  counts: { mergeState: {}, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } },
  hotFiles: [{ path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 8 }],
  items: Array.from({ length: 8 }, (_, i) => item(100 + i, ['src/cli/fleet.ts'])).concat(item(200, ['docs/fake.md'], 'CLEAN')),
};
const row: LaneTargetRow = { lane: 'codex-personal', target: 16, floor: 0, ceiling: 16, held: true, heldUntil: '2099-01-01T20:02:00', heldReason: 'autobackoff', lastChange: null, changedBy: null };
const targets: PreflightTargets = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [
  { ...row, running: 16, queued: 14 },
  { ...row, lane: 'devin', target: 4, held: false, running: 2, queued: 0 },
  { ...row, lane: 'claude', target: 4, held: true, running: 0, queued: 0 },
] };

it('extracts unique paths in order and caps them at 40', () => {
  expect(extractPaths('src/a.tsx src/a.tsx docs/a.md test/a.json scripts/run.mjs')).toEqual(['src/a.tsx', 'docs/a.md', 'test/a.json', 'scripts/run.mjs']);
  expect(extractPaths(Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`).join(' '))).toHaveLength(40);
});
it('finds hot and other open files and limits PR numbers', () => {
  expect(hotFileWarnings(['docs/fake.md', 'src/cli/fleet.ts', 'src/new.ts'], backlog)).toEqual([
    { path: 'src/cli/fleet.ts', dirtyPrs: 8, prNumbers: [100, 101, 102, 103, 104] },
    { path: 'docs/fake.md', dirtyPrs: 0, prNumbers: [200] },
  ]);
  expect(hotFileWarnings(['src/new.ts'], backlog)).toEqual([]);
  expect(hotFileWarnings(['src/cli/fleet.ts'], { ...backlog, source: 'gh-failed' })).toEqual([]);
});
it('reports holds, capacity and the best unheld alternative', () => {
  expect(laneLine('codex-personal', targets, 0)).toBe('codex-personal is held until 20:02 (autobackoff); devin has 2 free slots');
  const unheld = { ...targets, lanes: targets.lanes.map(lane => ({ ...lane, held: false })) };
  expect(laneLine('codex-personal', unheld, 0)).toBe('codex-personal: 16 of 16 running, 14 waiting; claude has 4 free slots');
  expect(laneLine('devin', unheld, 0)).toBe('devin: 2 of 4 running, 0 waiting');
  expect(laneLine('missing', targets, 0)).toBeNull();
  expect(laneLine('devin', null, 0)).toBeNull();
  expect(laneLine('devin', { ...targets, sourceState: 'missing' }, 0)).toBeNull();
  expect(laneLine('codex-personal', { ...targets, lanes: [row] }, 0)).toBe('codex-personal is held until 20:02 (autobackoff)');
});
