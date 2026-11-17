import { afterEach, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { readEmptyJobs, type EmptyJobsReader } from '../src/core/fleet/empty-jobs.js';
import { diagnoseEmptyJob, EMPTY_JOB_REASONS } from '../src/core/fleet/empty-why-classify.js';
import { jobFamily } from '../src/core/fleet/slot-yield.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const fixtures = [
  ['already-on-master', 'The change is already on master.', 'RESULT EMPTY'],
  ['no-op change', 'Inspection complete.', 'No changes needed.\nRESULT EMPTY'],
  ['scope too vague', 'The goal is too vague.', 'RESULT EMPTY'],
  ['sandbox or permission denial', 'Sandbox denied file access; nothing to change.', 'RESULT EMPTY'],
  ['test or typecheck failed and was reverted', 'Typecheck failed. Changes were reverted.', 'RESULT EMPTY'],
  ['timed out', 'Worker timed out.', 'RESULT EMPTY'],
  ['provider quota or rate limit', 'Provider quota exhausted.', 'RESULT EMPTY'],
  ['tool error', 'command not found: sample-tool', 'RESULT EMPTY'],
  ['unknown', 'Inspection ended.', 'RESULT EMPTY'],
] as const;
const row = (job: string, more: object = {}) => JSON.stringify({ event: 'finish', job, lane: 'work', empty: true, ts: '2026-11-17T11:00:00Z', ...more });
const reader = (ledger: string, files: Record<string, string> = {}): EmptyJobsReader => async path =>
  basename(path) === 'jobs.jsonl' ? ledger : files[basename(path)] ?? null;
afterEach(() => vi.restoreAllMocks());

it.each(fixtures)('diagnoses the %s fixture through the shared reader', async (reason, log, publish) => {
  const report = await readEmptyJobs(24, '/fixture/runs', '/fixture/wt', now, {
    read: reader(row('SAMPLE'), { 'SAMPLE.log': log, 'SAMPLE.publish': publish }),
  });
  expect(report?.diagnosis?.jobs).toEqual([{ id: 'SAMPLE', lane: 'work', family: 'SAMPLE', reason }]);
  expect(JSON.stringify(report)).not.toContain(log);
});

it('covers the closed reason list, ignores prompt heads and distinguishes missing evidence', () => {
  expect(fixtures.map(([reason]) => reason)).toEqual([...EMPTY_JOB_REASONS]);
  expect(diagnoseEmptyJob(null, null)).toBe('unknown');
  expect(diagnoseEmptyJob('Tests failed, changes retained.', 'RESULT EMPTY')).toBe('unknown');
  expect(diagnoseEmptyJob(['permission denied', ...Array(60).fill('progress')].join('\n'), null)).toBe('unknown');
  expect(diagnoseEmptyJob('Already on master.', 'EACCES\nRESULT EMPTY')).toBe('sandbox or permission denial');
});

it('groups recut cycles, filters before reading evidence, and serializes deterministically', async () => {
  const ids = ['RECUTCOREC544', 'RECUTCOREC541'];
  const read = vi.fn(reader([...ids.map(id => row(id)), row('OTHER')].join('\n'), {
    'RECUTCOREC544.log': 'already on master', 'RECUTCOREC541.publish': 'already merged into main',
  }));
  const run = () => readEmptyJobs(24, '/fixture/runs', '/fixture/wt', now, { read, family: 'RECUTCOREC541' });
  const report = await run();
  expect(jobFamily(ids[0]!)).toBe(jobFamily(ids[1]!));
  expect(report?.total).toBe(2);
  expect(report?.diagnosis?.families).toEqual([{ name: 'RECUT*', total: 2, topReason: 'already-on-master', suggestion: 'stop queuing this family' }]);
  expect(report?.diagnosis?.lanes[0]).toEqual({ name: 'work', total: 2, topReason: 'already-on-master', suggestion: 'stop queuing this family' });
  expect(report?.diagnosis?.jobs.map(j => j.id)).toEqual([...ids].sort());
  expect(read.mock.calls.some(([path]) => basename(path).startsWith('OTHER.'))).toBe(false);
  expect(JSON.stringify(await run())).toBe(JSON.stringify(report));
});

it('keeps all empty diagnoses, newest finish semantics, window bounds and safe paths', async () => {
  const ledger = [row('RETRIED'), row('RETRIED', { empty: false, ts: '2026-11-17T11:30:00Z' }),
    row('OLD', { ts: '2026-11-15T11:00:00Z' }), row('../escape'), row('FUTURE', { ts: '2026-11-18T11:00:00Z' }),
    ...Array.from({ length: 60 }, (_, i) => row(`SAMPLE${i}`))].join('\n');
  const read = vi.fn(reader(ledger));
  const report = await readEmptyJobs(24, '/fixture/runs', '/fixture/wt', now, { read });
  expect(read.mock.calls.every(([path]) => !path.includes('escape'))).toBe(true);
  expect(report?.diagnosis?.jobs).toHaveLength(60);
  expect(report?.diagnosis?.jobs.every(j => j.reason === 'unknown')).toBe(true);
  expect(await readEmptyJobs(24, '/fixture/runs', '/fixture/wt', now, { read: async () => { throw new Error('unreadable'); } })).toBeNull();
});

it('prints JSON and plain suggestions through the CLI and rejects missing family values', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read: typeof readEmptyJobs = (hours, _root, _wt, _now, options) => readEmptyJobs(hours, '/fixture/runs', '/fixture/wt', now,
    { ...options, read: reader(row('RECUTCOREC541'), { 'RECUTCOREC541.log': 'scope too vague' }) });
  expect(await cmdJobs(['empty', '--since', '24h', '--family', 'RECUT*', '--json'], read)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0]).diagnosis.jobs[0].reason).toBe('scope too vague');
  expect(await cmdJobs(['empty'], read)).toBe(0);
  expect(output.mock.calls.flat().join('\n')).toContain('make the goal concrete');
  expect(await cmdJobs(['empty', '--family'], read)).toBe(2);
  expect(await cmdJobs(['empty', '--since', '0h'], read)).toBe(2);
});
