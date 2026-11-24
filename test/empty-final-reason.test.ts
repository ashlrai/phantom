import { afterEach, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { readEmptyJobs, type EmptyJobsReader } from '../src/core/fleet/empty-jobs.js';
import { classifyFinalEmpty, FINAL_EMPTY_REASONS, summarizeFinalEmpty } from '../src/core/fleet/empty-final-reason.js';
import { emptyNoteFor, narrowLaneHealth } from '../src/core/fleet/lane-badge.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const fixtures = [
  ['already-shipped', 'I checked master and this fix is already on master, so I made no edits.'],
  ['no-change-needed', 'Reviewed the docs page. No change needed.'],
  ['repo-rule', 'I stopped because CODEOWNERS reserves these paths for the owner.'],
  ['blocked-dependency', 'This job is blocked on another job that has not merged yet.'],
  ['tool-missing', 'The formatter failed: command not found.'],
  ['usage-out', 'I am out of usage for this window and cannot continue.'],
  ['sign-in-failed', 'The worker stopped: auth_failed, please sign in again.'],
  ['lane-held', 'This lane is HELD until the weekly window resets.'],
  ['timeout', 'The test suite was too slow and the run timed out.'],
] as const;

it.each(fixtures)('names %s and quotes the sentence', (reason, sentence) => {
  const verdict = classifyFinalEmpty(`Working on it.\nreading files\n\n${sentence}\nRESULT EMPTY`);
  expect(verdict.reason).toBe(reason);
  expect(sentence).toContain(verdict.sentence!.replace(/…$/, ''));
});

it('covers the full list, with unknown for a log that has no final message', () => {
  expect([...fixtures.map(([r]) => r), 'unknown']).toEqual([...FINAL_EMPTY_REASONS]);
  expect(classifyFinalEmpty(null)).toEqual({ reason: 'unknown', sentence: null });
  expect(classifyFinalEmpty('')).toEqual({ reason: 'unknown', sentence: null });
  expect(classifyFinalEmpty('RESULT EMPTY')).toEqual({ reason: 'unknown', sentence: null });
});

it('lets a hard stop outrank no-change wording and reads only the final lines', () => {
  expect(classifyFinalEmpty('No change needed. Then the run hit the usage limit.').reason).toBe('usage-out');
  expect(classifyFinalEmpty(['The run timed out.', ...Array(45).fill('progress')].join('\n')).reason).toBe('unknown');
});

it('summarizes per lane with the five newest examples per reason', () => {
  const jobs = Array.from({ length: 7 }, (_, i) => ({ id: `J${i}`, lane: i < 6 ? 'zai' : 'grok', verdict: classifyFinalEmpty('Already on master.') }));
  const report = summarizeFinalEmpty([...jobs, { id: 'J7', lane: 'zai', verdict: classifyFinalEmpty(null) }]);
  expect(report.schema).toBe('jobs.empty-final.v1');
  expect(report.reasons['already-shipped']).toBe(7);
  expect(report.lanes[0]).toMatchObject({ lane: 'zai', total: 7, top: 'already-shipped' });
  expect(report.examples['already-shipped']!.map(e => e.id)).toEqual(['J6', 'J5', 'J4', 'J3', 'J2']);
  expect(report.examples.unknown).toEqual([{ id: 'J7', lane: 'zai', sentence: null }]);
});

const row = (job: string, lane: string) => JSON.stringify({ event: 'finish', job, lane, empty: true, ts: '2026-11-17T11:00:00Z' });
const reader = (ledger: string, files: Record<string, string>): EmptyJobsReader => async path =>
  basename(path) === 'jobs.jsonl' ? ledger : files[basename(path)] ?? null;
afterEach(() => vi.restoreAllMocks());

it('filters by lane and prints No empty jobs. for an empty set', async () => {
  const read = reader([row('A', 'zai'), row('B', 'grok')].join('\n'), { 'A.log': 'Nothing to change.', 'B.log': 'Out of usage.' });
  const all = await readEmptyJobs(24, '/r', '/w', now, { read });
  expect(all?.final?.lanes.map(l => `${l.lane}:${l.top}`)).toEqual(['grok:usage-out', 'zai:no-change-needed']);
  const grok = await readEmptyJobs(24, '/r', '/w', now, { read, lane: 'grok' });
  expect(grok?.total).toBe(1);

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  expect(await cmdJobs(['empty', '--lane', 'nobody'], (h, r, w, n, o) => readEmptyJobs(h, r, w, now, { ...o, read }))).toBe(0);
  expect(lines).toEqual(['No empty jobs.']);
  lines.length = 0;
  expect(await cmdJobs(['empty', '--json', '--lane', 'zai'], (h, r, w, n, o) => readEmptyJobs(h, r, w, now, { ...o, read }))).toBe(0);
  expect(JSON.parse(lines[0]!).final.schema).toBe('jobs.empty-final.v1');
});

it('builds a tooltip note and carries it through the badge guard', () => {
  expect(emptyNoteFor('already-shipped', 3, 5)).toBe('top empty reason: already-shipped (3 of 5 empty jobs)');
  expect(emptyNoteFor('unknown', 3, 5)).toBeNull();
  expect(narrowLaneHealth({ state: 'ok', reason: 'ok', number: null, emptyNote: 'top empty reason: timeout (2 of 2 empty jobs)' })?.emptyNote).toContain('timeout');
});

it('keeps log sentences out of the report unless the caller asks to quote', async () => {
  const read = reader(row('A', 'zai'), { 'A.log': 'Nothing to change here.' });
  expect((await readEmptyJobs(24, '/r', '/w', now, { read }))?.final?.examples['no-change-needed']).toEqual([{ id: 'A', lane: 'zai', sentence: null }]);
  expect((await readEmptyJobs(24, '/r', '/w', now, { read, quote: true }))?.final?.examples['no-change-needed']?.[0]?.sentence).toBe('Nothing to change here.');
});
