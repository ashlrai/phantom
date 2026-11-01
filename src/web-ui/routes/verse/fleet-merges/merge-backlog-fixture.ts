import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
export const snapshot: MergeBacklogReadV1 = {
  v: 1, repo: 'fake/repo', generatedAt: '', source: 'ok',
  counts: { mergeState: { DIRTY: 4, CLEAN: 1 }, actions: { merge: 0, recut: 2, refresh: 0, wait: 0, none: 0 } },
  hotFiles: [{ path: 'src/cli/fleet.ts', dirtyPrs: 2, openPrs: 3 }],
  items: [1, 2, 3].map(number => ({ number, title: '', headRef: '', updatedAt: `2026-11-01T0${number}:00:00Z`, mergeStateStatus: number === 1 ? 'CLEAN' : 'DIRTY', isDraft: false, job: 'RQ-PHX-FAKE31', classification: { class: 'conflicted', work: 'refix', reason: 'fake' }, suggestedAction: 'recut', files: ['src/cli/fleet.ts'] })),
};
