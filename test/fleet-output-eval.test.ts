import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldOutputEval, recordOutputEval, reportOutputEval } from '../src/core/fleet/output-eval.js';

const lines = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
describe('output evaluation', () => {
  it('joins terminal outcomes, deduplicates observations, and excludes incomplete or conflicting attempts', () => {
    const data = lines([
      { event: 'outcome', job: 'one', state: 'MERGED' },
      { event: 'launch', job: 'one', lane: 'work', model: 'model-a', prompt: 'private content' },
      { event: 'outcome', job: 'one', state: 'MERGED' },
      { event: 'launch', job: 'two', lane: 'work', model: 'model-a' },
      { event: 'finish', job: 'two', empty: true },
      { event: 'launch', job: 'three', lane: 'work', model: 'model-b' },
      { class: 'abort_push', job: 'three' },
      { event: 'launch', job: 'unknown', lane: 'work' },
      { event: 'finish', job: 'unknown', empty: true },
      { event: 'launch', job: 'conflict', lane: 'work', model: 'a' },
      { event: 'launch', job: 'conflict', lane: 'work', model: 'b' },
      { event: 'outcome', job: 'conflict', state: 'MERGED' },
      { event: 'launch', job: 'pending', lane: 'work', model: 'a' },
    ]);
    const result = foldOutputEval(data);
    expect(result.excluded).toBe(3);
    expect(result.records).toEqual([
      { job: 'one', lane: 'work', model: 'model-a', outcome: 'merged' },
      { job: 'three', lane: 'work', model: 'model-b', outcome: 'aborted' },
      { job: 'two', lane: 'work', model: 'model-a', outcome: 'empty' },
    ]);
  });
  it('writes only identifiers and outcomes, replaces the snapshot and reports rates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-')); const jobs = join(dir, 'jobs'); const store = join(dir, 'store');
    await writeFile(jobs, lines([{ event: 'launch', job: 'j1', lane: 'work', model: 'a', prompt: 'private content' }, { event: 'outcome', job: 'j1', state: 'MERGED' }, { event: 'launch', job: 'j2', lane: 'work', model: 'a' }, { event: 'finish', job: 'j2', empty: true }]));
    expect(await recordOutputEval(jobs, store)).toEqual({ recorded: 2, excluded: 0 });
    expect(await readFile(store, 'utf8')).not.toContain('private content');
    expect((await reportOutputEval(store)).models).toEqual([{ lane: 'work', model: 'a', merged: 1, aborted: 0, empty: 1, total: 2, mergeRate: 0.5 }]);
    await expect(recordOutputEval(jobs, jobs)).rejects.toThrow();
    await writeFile(store, '{"schema":"fleet.output-eval.store.v1","records":[{},{}]}');
    await expect(reportOutputEval(store)).rejects.toThrow();
  });
});
