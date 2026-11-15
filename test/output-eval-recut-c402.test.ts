import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldOutputEval, recordOutputEval, reportOutputEval } from '../src/core/fleet/output-eval.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'output-eval-recut-'));
  dirs.push(path);
  return path;
};

const lines = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');

// Claims from docs/OUTPUT-EVAL.md exercised through the real exported
// functions: every outcome-event synonym counts as terminal evidence,
// reconciler rows qualify through `status` as well as `outcome`, and
// secret-shaped or invalid identifiers are rejected rather than recorded.
describe('output-eval documented contract (recut c402)', () => {
  it('treats result, resolved and resolution events as terminal evidence like outcome', () => {
    const result = foldOutputEval(lines([
      { event: 'launch', job: 'J-OUT', lane: 'devin', model: 'a' },
      { event: 'outcome', job: 'J-OUT', state: 'MERGED' },
      { event: 'launch', job: 'J-RES', lane: 'devin', model: 'a' },
      { event: 'result', job: 'J-RES', state: 'MERGED' },
      { event: 'launch', job: 'J-SLV', lane: 'work', model: 'b' },
      { event: 'resolved', job: 'J-SLV', status: 'aborted' },
      { event: 'launch', job: 'J-RSN', lane: 'work', model: 'b' },
      { event: 'resolution', job: 'J-RSN', outcome: 'MERGED' },
      { event: 'launch', job: 'J-REC', lane: 'zai', model: 'c' },
      { source: 'metrics-outcomes-reconciler', jobId: 'J-REC', status: 'MERGED' },
    ]));
    expect(result.excluded).toBe(0);
    expect(result.records).toEqual([
      { job: 'J-OUT', lane: 'devin', model: 'a', outcome: 'merged' },
      { job: 'J-REC', lane: 'zai', model: 'c', outcome: 'merged' },
      { job: 'J-RES', lane: 'devin', model: 'a', outcome: 'merged' },
      { job: 'J-RSN', lane: 'work', model: 'b', outcome: 'merged' },
      { job: 'J-SLV', lane: 'work', model: 'b', outcome: 'aborted' },
    ]);
  });

  it('rejects secret-shaped or invalid identifiers instead of recording them', () => {
    const result = foldOutputEval(lines([
      // A hex-64 job id fails token() outright: its rows are dropped unread.
      { event: 'launch', job: 'a'.repeat(64), lane: 'devin', model: 'a' },
      { event: 'outcome', job: 'a'.repeat(64), state: 'MERGED' },
      // A secret-shaped lane and an invalid lane mark the launch 'invalid'
      // and exclude the whole job.
      { event: 'launch', job: 'J-OK', lane: 'ghp_' + 'a'.repeat(36), model: 'a' },
      { event: 'outcome', job: 'J-OK', state: 'MERGED' },
      { event: 'launch', job: 'J-SPACE', lane: 'bad lane', model: 'a' },
      { event: 'outcome', job: 'J-SPACE', state: 'MERGED' },
    ]));
    expect(result.records).toEqual([]);
    expect(result.excluded).toBe(2);
  });

  it('records then reports only categorized terminal outcomes', async () => {
    const root = dir();
    const jobs = join(root, 'jobs.jsonl');
    const store = join(root, 'store', 'output-eval.json');
    writeFileSync(jobs, lines([
      { event: 'launch', job: 'J-1', lane: 'devin', model: 'a' },
      { event: 'resolution', job: 'J-1', state: 'MERGED' },
      { event: 'launch', job: 'J-2', lane: 'devin', model: 'a' },
      { event: 'finish', job: 'J-2', empty: false, exit_code: 1 },
    ]));
    expect(await recordOutputEval(jobs, store)).toEqual({ recorded: 1, excluded: 1 });
    const report = await reportOutputEval(store);
    expect(report.schema).toBe('fleet.output-eval.report.v1');
    expect(report.lanes).toEqual([{ lane: 'devin', merged: 1, aborted: 0, empty: 0, total: 1, mergeRate: 1 }]);
    expect(JSON.stringify(report)).not.toContain('J-2');
  });
});
