import { expect, it } from 'vitest';
import { changesHeadline, isJobChanges, sortFiles, type FleetJobChangesV1 } from './worker-changes-model.js';
export const changes: FleetJobChangesV1 = { schema: 'fleet.job.changes.v1', generatedAt: 'now', job: 'RQ-TEST', state: 'live', baseSha: 'a60908e123', files: [{ path: 'src/file.ts', added: 212, removed: 18, status: 'modified' }], totals: { files: 6, added: 212, removed: 18 }, truncated: false };
it('validates the wire shape', () => {
  expect(isJobChanges(changes)).toBe(true);
  for (const bad of [null, {}, { ...changes, files: [{}] }, { ...changes, totals: { files: -1 } }, { ...changes, state: 'other' }]) expect(isJobChanges(bad)).toBe(false);
});
it('formats totals and the short base', () => { expect(changesHeadline(changes)).toBe('Changes · 6 files · +212 −18 · vs base a60908e'); });
it('sorts by churn then path without mutation', () => {
  const files = ['z', 'b', 'a'].map((path, i) => ({ ...changes.files[0]!, path, added: i ? 2 : 1, removed: 0 }));
  expect(sortFiles(files).map(file => file.path)).toEqual(['a', 'b', 'z']); expect(files[0]?.path).toBe('z');
});
