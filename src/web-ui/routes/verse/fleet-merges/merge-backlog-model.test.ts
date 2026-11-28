import { expect, it } from 'vitest';
import { snapshot } from './merge-backlog-fixture.js';
import { backlogView } from './merge-backlog-model.js';

it('orders DIRTY first then oldest and names the shared file', () => {
  const view = backlogView(snapshot, Date.parse('2026-11-01T05:00:00Z'));
  expect(view.rows.map(row => row.number)).toEqual([2, 3, 1]);
  expect(view.rows[0]).toMatchObject({ ageText: '3 h', hotFile: 'src/cli/fleet.ts' });
  expect(view.hotFilesLine).toBe('Hot files: fleet.ts in 2 of 4 DIRTY PRs');
  expect(view.danger).toBe(true);
});
it('omits hot files when none repeats', () => {
  expect(backlogView({ ...snapshot, hotFiles: [{ path: 'a', dirtyPrs: 1, openPrs: 5 }] }, 0).hotFilesLine).toBeNull();
});
it('formats multiple hot files with the denominator only on the first', () => {
  const read = { ...snapshot, counts: { ...snapshot.counts, mergeState: { DIRTY: 16 } }, hotFiles: [
    { path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 9 }, { path: 'src/completions.ts', dirtyPrs: 5, openPrs: 5 },
  ] };
  expect(backlogView(read, 0).hotFilesLine).toBe('Hot files: fleet.ts in 8 of 16 DIRTY PRs · completions.ts in 5');
});

it('reports unknown age without inventing zero for missing or invalid timestamps', () => {
  for (const updatedAt of [null, 'invalid']) {
    const view = backlogView({ ...snapshot, items: [{ ...snapshot.items[0]!, updatedAt }] }, 0);
    expect(view.rows[0]?.ageText).toBe('age unknown');
  }
});

it('labels a capped page as a sample and does not escalate a sample-only hot file', () => {
  const view = backlogView({ ...snapshot, coverage: { limit: 3, scanned: 3, discarded: 0, complete: false } }, 0);
  expect(view.countsLine).toContain('3 sampled PRs');
  expect(view.coverageLine).toBe('Read 3 of up to 3 records. Total open PRs unknown.');
  expect(view.danger).toBe(false);
});

it('does not infer an empty backlog from missing coverage metadata', () => {
  const view = backlogView({ ...snapshot, items: [], coverage: undefined }, 0);
  expect(view.complete).toBe(false);
  expect(view.coverageLine).toContain('Total open PRs unknown');
});
