import { describe, expect, it } from 'vitest';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { foldOutputEval, recordOutputEval, reportOutputEval } from '../src/core/fleet/output-eval.js';

const lines = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');

// Exercises the contract documented in docs/OUTPUT-EVAL.md through the real
// record/report exports (no mocks): every claim below names a doc sentence.
describe('output-eval documented contract (recut c402)', () => {
  it('treats result, resolved and resolution events plus metrics-outcomes-reconciler rows as terminal evidence', () => {
    const folded = foldOutputEval(lines([
      { event: 'launch', job: 'a', lane: 'work', model: 'm1' },
      { event: 'result', job: 'a', state: 'MERGED' },
      { event: 'launch', job: 'b', lane: 'work', model: 'm1' },
      { event: 'resolved', job: 'b', outcome: 'aborted' },
      { event: 'launch', job: 'c', lane: 'work', model: 'm2' },
      { event: 'resolution', job: 'c', state: 'merged' },
      { event: 'launch', job: 'd', lane: 'work', model: 'm2' },
      { source: 'metrics-outcomes-reconciler', job: 'd', status: 'merged' },
      { source: 'metrics-outcomes-reconciler', job: 'e', status: 'aborted' },
    ]));
    expect(folded.records).toEqual([
      { job: 'a', lane: 'work', model: 'm1', outcome: 'merged' },
      { job: 'b', lane: 'work', model: 'm1', outcome: 'aborted' },
      { job: 'c', lane: 'work', model: 'm2', outcome: 'merged' },
      { job: 'd', lane: 'work', model: 'm2', outcome: 'merged' },
    ]);
    // 'e' has terminal evidence but no launch: missing attribution is excluded.
    expect(folded.excluded).toBe(1);
  });

  it('rejects secret-shaped identifiers instead of recording them', () => {
    const folded = foldOutputEval(lines([
      { event: 'launch', job: 'AKIAIOSFODNN7EXAMPLE', lane: 'work', model: 'm1' },
      { event: 'outcome', job: 'AKIAIOSFODNN7EXAMPLE', state: 'MERGED' },
      { event: 'launch', job: 'real-job', lane: 'work', model: 'AKIAIOSFODNN7EXAMPLE' },
      { event: 'outcome', job: 'real-job', state: 'MERGED' },
    ]));
    expect(folded.records).toEqual([]);
    // The AWS-key job never registers; real-job launches with an unusable model
    // are excluded rather than letting a missing model be guessed.
    expect(folded.excluded).toBe(1);
  });

  it('writes the snapshot mode 0600 in a fresh 0700 directory and reports lane and lane+model rates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'output-eval-recut-'));
    const jobs = join(dir, 'jobs.jsonl');
    const store = join(dir, 'fresh', 'output-eval.json');
    await writeFile(jobs, lines([
      { event: 'launch', job: 'j1', lane: 'work', model: 'm1', prompt: 'private content' },
      { event: 'outcome', job: 'j1', state: 'MERGED' },
      { event: 'launch', job: 'j2', lane: 'work', model: 'm2' },
      { event: 'finish', job: 'j2', empty: true },
      { event: 'launch', job: 'j3', lane: 'fast', model: 'm1' },
      { event: 'outcome', job: 'j3', state: 'ABORTED' },
    ]));
    expect(await recordOutputEval(jobs, store)).toEqual({ recorded: 3, excluded: 0 });
    if (process.platform !== 'win32') {
      expect((await stat(store)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(store))).mode & 0o777).toBe(0o700);
    }
    const report = await reportOutputEval(store);
    expect(report.schema).toBe('fleet.output-eval.report.v1');
    expect(report.lanes).toEqual([
      { lane: 'fast', merged: 0, aborted: 1, empty: 0, total: 1, mergeRate: 0 },
      { lane: 'work', merged: 1, aborted: 0, empty: 1, total: 2, mergeRate: 0.5 },
    ]);
    expect(report.models).toEqual([
      { lane: 'fast', model: 'm1', merged: 0, aborted: 1, empty: 0, total: 1, mergeRate: 0 },
      { lane: 'work', model: 'm1', merged: 1, aborted: 0, empty: 0, total: 1, mergeRate: 1 },
      { lane: 'work', model: 'm2', merged: 0, aborted: 0, empty: 1, total: 1, mergeRate: 0 },
    ]);
  });

  it('fails on a missing or invalid store instead of reporting zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'output-eval-recut-missing-'));
    await expect(reportOutputEval(join(dir, 'absent.json'))).rejects.toThrow();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"schema":"fleet.output-eval.store.v1","records":[{"job":"x"}]}');
    await expect(reportOutputEval(bad)).rejects.toThrow('invalid store');
  });
});
