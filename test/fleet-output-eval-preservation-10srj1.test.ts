import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetOutputEval } from '../src/cli/fleet-output-eval.js';
import { foldOutputEval } from '../src/core/fleet/output-eval.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'output-eval-'));
  dirs.push(path);
  return path;
};

// Rows in the observed jobs.jsonl vocabulary: launch carries lane+model,
// finish carries empty, the reconciler appends MERGED/CLOSED with only
// source+outcome (no event), and aborts arrive as class: abort_* rows.
const LEDGER = [
  { event: 'launch', job: 'RQ-A-1', lane: 'devin', model: 'swe-2', repo: 'ashlrai/phantom', ts: '2026-11-10T01:00:00Z' },
  { source: 'metrics-outcomes-reconciler', jobId: 'RQ-A-1', prUrl: 'https://github.com/ashlrai/phantom/pull/1', outcome: 'MERGED', pool: 'devin', ts: '2026-11-10T02:00:00Z' },
  { source: 'metrics-outcomes-reconciler', jobId: 'RQ-A-1', prUrl: 'https://github.com/ashlrai/phantom/pull/1', outcome: 'MERGED', pool: 'devin', ts: '2026-11-10T02:00:00Z' },
  { event: 'launch', job: 'RQ-B-2', lane: 'devin', model: 'swe-2', ts: '2026-11-10T01:00:00Z' },
  { event: 'finish', job: 'RQ-B-2', lane: 'devin', empty: true, exit_code: 0, ts: '2026-11-10T02:00:00Z' },
  { event: 'launch', job: 'RQ-C-3', lane: 'claude', model: 'opus', ts: '2026-11-10T01:00:00Z' },
  { class: 'abort_push', job: 'RQ-C-3', lane: 'claude', ts: '2026-11-10T02:00:00Z' },
  { event: 'launch', job: 'RQ-D-4', lane: 'devin', model: 'swe-2', ts: '2026-11-10T01:00:00Z' },
  { event: 'launch', job: 'RQ-D-4', lane: 'devin', model: 'swe-2', ts: '2026-11-10T03:00:00Z' },
  { source: 'metrics-outcomes-reconciler', jobId: 'RQ-D-4', prUrl: 'https://github.com/ashlrai/phantom/pull/4', outcome: 'MERGED', ts: '2026-11-10T04:00:00Z' },
  { event: 'launch', job: 'RQ-E-5', lane: 'zai', model: 'glm', ts: '2026-11-10T01:00:00Z' },
  { event: 'finish', job: 'RQ-E-5', lane: 'zai', empty: false, exit_code: 1, ts: '2026-11-10T02:00:00Z' },
].map(row => JSON.stringify(row)).join('\n');

it('records then reports real outcomes end-to-end without touching the source ledger', async () => {
  const root = dir();
  const jobs = join(root, 'jobs.jsonl');
  const store = join(root, 'nested', 'output-eval.json');
  writeFileSync(jobs, LEDGER);
  const before = readFileSync(jobs, 'utf8');

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await cmdFleetOutputEval(['record', '--jobs', jobs, '--store', store, '--json'])).toBe(0);
  const recorded = JSON.parse(log.mock.calls.at(-1)![0] as string);
  // RQ-A merged (deduped reconciler rows), RQ-B empty, RQ-C aborted;
  // RQ-D excluded: two launch attempts share the job id; RQ-E excluded: no terminal outcome.
  expect(recorded).toEqual({ recorded: 3, excluded: 2 });
  expect(readFileSync(jobs, 'utf8')).toBe(before);

  // Owner-only derived store: private file inside a private directory.
  expect(statSync(store).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700);
  const persisted = JSON.parse(readFileSync(store, 'utf8'));
  expect(persisted.schema).toBe('fleet.output-eval.store.v1');
  expect(JSON.stringify(persisted)).not.toContain('prUrl');
  expect(JSON.stringify(persisted)).not.toContain('pull/1');

  // Re-recording the same ledger replaces the snapshot deterministically.
  log.mockClear();
  expect(await cmdFleetOutputEval(['record', '--jobs', jobs, '--store', store, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual(recorded);
  expect(readFileSync(store, 'utf8')).toBe(JSON.stringify(persisted) + '\n');

  log.mockClear();
  expect(await cmdFleetOutputEval(['report', '--store', store, '--json'])).toBe(0);
  const report = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(report.schema).toBe('fleet.output-eval.report.v1');
  expect(report.models).toEqual([
    { lane: 'claude', model: 'opus', merged: 0, aborted: 1, empty: 0, total: 1, mergeRate: 0 },
    { lane: 'devin', model: 'swe-2', merged: 1, aborted: 0, empty: 1, total: 2, mergeRate: 0.5 },
  ]);
  expect(report.lanes).toEqual([
    { lane: 'claude', merged: 0, aborted: 1, empty: 0, total: 1, mergeRate: 0 },
    { lane: 'devin', merged: 1, aborted: 0, empty: 1, total: 2, mergeRate: 0.5 },
  ]);
  expect(err).not.toHaveBeenCalled();
});

it('reports a missing or corrupt store honestly and rejects bad usage', async () => {
  const root = dir();
  const missing = join(root, 'missing.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await cmdFleetOutputEval(['report', '--store', missing, '--json'])).toBe(1);
  expect(log).not.toHaveBeenCalled();
  expect(err.mock.calls.at(-1)![0]).toMatch(/unable to read or write output evaluation/);

  const corrupt = join(root, 'corrupt.json');
  writeFileSync(corrupt, '{"schema":"fleet.output-eval.store.v1","records":[{}]}');
  expect(await cmdFleetOutputEval(['report', '--store', corrupt])).toBe(1);

  expect(await cmdFleetOutputEval(['bogus'])).toBe(2);
  expect(await cmdFleetOutputEval(['record', '--jobs'])).toBe(2);
  expect(log.mock.calls.length).toBe(0);
});

it('fold excludes repeated-attempt jobs and conflicting terminal evidence', () => {
  const result = foldOutputEval(LEDGER);
  expect(result.records.map(r => r.job)).toEqual(['RQ-A-1', 'RQ-B-2', 'RQ-C-3']);
  expect(result.excluded).toBe(2);
  // A job with both a merge and an abort is ambiguous, not double-counted.
  const conflict = foldOutputEval(JSON.stringify({ event: 'launch', job: 'J', lane: 'l', model: 'm' }) + '\n'
    + JSON.stringify({ event: 'outcome', job: 'J', state: 'MERGED' }) + '\n'
    + JSON.stringify({ class: 'abort_pr', job: 'J' }));
  expect(conflict).toEqual({ records: [], excluded: 1 });
});
