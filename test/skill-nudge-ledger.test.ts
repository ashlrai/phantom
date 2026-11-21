/** Inert fixtures only. No provider calls, real home or credentials. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCard } from '../src/core/types.js';
import {
  skillNudgeJobsFromLedger, syncSkillNudgesFromJobsLedger,
} from '../src/core/fleet/skill-nudge.js';
import { readSkillCardCorpus, recordSkillCard } from '../src/core/fleet/skill-records.js';

// Exercise the actual record sanitizer without real filesystem I/O.
vi.mock('../src/core/fleet/skill-records.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/skill-records.js')>();
  return { ...actual, readSkillCardCorpus: vi.fn(), recordSkillCard: vi.fn() };
});

const line = (row: Record<string, unknown>): string => JSON.stringify(row);
const enqueue = (job: string, lane = 'codex', ts = '2026-10-28T09:00:00-0400') =>
  line({ event: 'enqueue', job, repo: 'ashlrai/phantom', lane, tier: 'work', ts });
const launch = (job: string, lane = 'codex', ts = '2026-10-28T10:00:00-0400') =>
  line({ event: 'launch', job, repo: 'ashlrai/phantom', lane, tier: 'work', ts });
const claim = (job: string, lane = 'codex', ts = '2026-10-28T09:59:00-0400') =>
  line({ event: 'claim', job, repo: 'ashlrai/phantom', lane, tier: 'work', launch_dedupe: true, ts });
const finish = (job: string, extra: Record<string, unknown> = {}, lane = 'codex') =>
  line({ event: 'finish', job, lane, wall_s: 60, exit_code: 1, empty: false, ts: '2026-10-28T12:00:00-0400', ...extra });
const outcome = (job: string, state: string, extra: Record<string, unknown> = {}) =>
  line({ event: 'outcome', job, state, repo: 'ashlrai/phantom', lane: 'codex', ts: '2026-10-28T15:00:00.000Z', ...extra });

let cards: SkillCard[];
let directory: string;
beforeEach(() => {
  cards = [];
  vi.mocked(readSkillCardCorpus).mockImplementation(() => ({ cards, sourceState: 'healthy', sourcePresent: true,
    filesScanned: 0, unreadableFiles: 0, invalidRows: 0, bytesScanned: 0, limitExceeded: false }));
  vi.mocked(recordSkillCard).mockImplementation(input => { cards.push(...(Array.isArray(input) ? input : [input])); });
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'skill-nudge-ledger-')));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('skillNudgeJobsFromLedger', () => {
  it('folds a retried merge into one job with retry and failure-class evidence', () => {
    const text = [
      enqueue('RQ-A'), claim('RQ-A'), launch('RQ-A'),
      finish('RQ-A', { failure_class: 'quota' }),
      launch('RQ-A', 'codex', '2026-10-28T13:00:00-0400'),
      outcome('RQ-A', 'MERGED'),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)).toEqual([{
      id: 'RQ-A', lane: 'codex', outcome: 'merged', retries: 1, failureClass: 'quota',
    }]);
  });

  it('counts a dedupe claim and its launch as one attempt', () => {
    const text = [claim('RQ-B'), launch('RQ-B'), outcome('RQ-B', 'MERGED')].join('\n');
    const [job] = skillNudgeJobsFromLedger(text);
    expect(job).toMatchObject({ id: 'RQ-B', outcome: 'merged' });
    expect(job).not.toHaveProperty('retries');
  });

  it('counts launch_failed retry receipts as retries and keeps their reason as the class', () => {
    const text = [
      launch('RQ-C'),
      line({ event: 'launch_failed', job: 'RQ-C', lane: 'codex', reason: 'launch_timeout', action: 'retry', attempt: 1, ts: '2026-10-28T10:30:00-0400' }),
      launch('RQ-C', 'codex', '2026-10-28T11:00:00-0400'),
      outcome('RQ-C', 'MERGED'),
    ].join('\n');
    const [job] = skillNudgeJobsFromLedger(text);
    expect(job).toMatchObject({ outcome: 'merged', retries: 2, failureClass: 'launch_timeout' });
  });

  it('ignores give_up launch failures for retries but keeps the reason', () => {
    const text = [
      launch('RQ-D'),
      line({ event: 'launch_failed', job: 'RQ-D', lane: 'codex', reason: 'launch_script_error', action: 'give_up', attempt: 3, ts: '2026-10-28T10:30:00-0400' }),
      outcome('RQ-D', 'CLOSED'),
    ].join('\n');
    const [job] = skillNudgeJobsFromLedger(text);
    expect(job).toMatchObject({ outcome: 'failed', failureClass: 'launch_script_error' });
    expect(job).not.toHaveProperty('retries');
  });

  it('resolves outcomes from phase fields regardless of event name, latest terminal wins', () => {
    const reconciled = line({ event: 'publish', job: 'RQ-E', outcome: 'MERGED',
      prUrl: 'https://github.com/ashlrai/phantom/pull/42', mergedAt: '2026-10-28T15:30:00.000Z', ts: '2026-10-28T15:31:00.000Z' });
    const text = [
      launch('RQ-E'), outcome('RQ-E', 'PUBLISHED'), reconciled,
      launch('RQ-F'), outcome('RQ-F', 'CLOSED'),
      launch('RQ-G'), outcome('RQ-G', 'DONE-NOOP', { launched: false }),
      launch('RQ-H'), outcome('RQ-H', 'CANCELLED'),
      launch('RQ-I'), outcome('RQ-I', 'OPEN'),
      launch('RQ-J'), line({ event: 'task_outcome', job: 'RQ-J', batch: 'B-1', lane: 'claude', outcome: 'done', ts: '2026-10-28T13:00:00-0400' }),
      launch('RQ-K'), line({ event: 'task_outcome', job: 'RQ-K', batch: 'B-1', lane: 'claude', outcome: 'failed', reason: 'Member worktree was not prepared for this session.', ts: '2026-10-28T13:00:00-0400' }),
      launch('RQ-L'), outcome('RQ-L', 'CLOSED'), outcome('RQ-L', 'MERGED'),
    ].join('\n');
    const jobs = skillNudgeJobsFromLedger(text);
    const byId = new Map(jobs.map(job => [job.id, job]));
    expect(byId.get('RQ-E')).toMatchObject({ outcome: 'merged' });
    expect(byId.get('RQ-F')).toMatchObject({ outcome: 'failed' });
    expect(byId.get('RQ-G')).toMatchObject({ outcome: 'empty' });
    expect(byId.get('RQ-H')).toMatchObject({ outcome: 'cancelled' });
    expect(byId.get('RQ-I')).not.toHaveProperty('outcome');
    expect(byId.get('RQ-J')).not.toHaveProperty('outcome');
    expect(byId.get('RQ-K')).toMatchObject({ outcome: 'failed' });
    expect(byId.get('RQ-L')).toMatchObject({ outcome: 'merged' });
  });

  it('marks reverted merges without dropping the merged outcome', () => {
    const text = [
      launch('RQ-M'), outcome('RQ-M', 'MERGED'),
      line({ event: 'revert', job: 'RQ-M', lane: 'codex', ts: '2026-10-28T16:00:00.000Z' }),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)[0]).toMatchObject({ outcome: 'merged', reverted: true });
  });

  it('uses the last execution-side lane and ignores queue hints', () => {
    const text = [
      enqueue('RQ-N', 'fast'), launch('RQ-N', 'codex'),
      finish('RQ-N', {}, 'devin'),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)[0]).toMatchObject({ lane: 'devin' });
  });

  it('keeps only identifier-safe failure classes and prefers finish fields', () => {
    const text = [
      launch('RQ-O'),
      finish('RQ-O', { failure_reason: 'agent_exit_nonzero', pool_error: 'rate_limit' }),
      finish('RQ-O', { failure_class: 'quota', failure_reason: null, pool_error: null }),
      launch('RQ-P'),
      finish('RQ-P', { failure_reason: 'Member worktree prose is not a class' }),
      launch('RQ-Q'),
      line({ event: 'task_outcome', job: 'RQ-Q', batch: 'B-2', lane: 'claude', outcome: 'failed', reason: 'not identifier safe at all!!', ts: '2026-10-28T13:00:00-0400' }),
    ].join('\n');
    const byId = new Map(skillNudgeJobsFromLedger(text).map(job => [job.id, job]));
    expect(byId.get('RQ-O')).toMatchObject({ failureClass: 'quota' });
    expect(byId.get('RQ-P')).not.toHaveProperty('failureClass');
    expect(byId.get('RQ-Q')).not.toHaveProperty('failureClass');
  });

  it('counts batch claims and recut admissions as retry/recut evidence', () => {
    const text = [
      line({ event: 'batch_claim', job: 'RQ-R', batch: 'B-3', repo: 'ashlrai/phantom', lane: 'claude', tier: 'fast', ts: '2026-10-28T10:00:00-0400' }),
      line({ event: 'batch_claim', job: 'RQ-R', batch: 'B-4', repo: 'ashlrai/phantom', lane: 'claude', tier: 'fast', ts: '2026-10-28T11:00:00-0400' }),
      line({ event: 'recut_admission', job: 'RQ-S', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT1L1', ts: '2026-10-28T10:00:00-0400' }),
      launch('RQ-S'),
      line({ event: 'recut_admission', job: 'RQ-S', repo: 'phantom', action: 'ready', reason: 'recut-no-current-coverage', repeatOf: null, ts: '2026-10-28T11:00:00-0400' }),
      line({ event: 'recut_admission', job: 'RQ-T', repo: 'phantom', action: 'skip', reason: 'recut-already-merged', repeatOf: 'RQ-PHX-RECUT2L1', ts: '2026-10-28T10:00:00-0400' }),
      launch('RQ-T'),
      outcome('RQ-R', 'MERGED'), outcome('RQ-S', 'MERGED'), outcome('RQ-T', 'MERGED'),
    ].join('\n');
    const byId = new Map(skillNudgeJobsFromLedger(text).map(job => [job.id, job]));
    expect(byId.get('RQ-R')).toMatchObject({ outcome: 'merged', retries: 1 });
    expect(byId.get('RQ-S')).toMatchObject({ outcome: 'merged', recuts: 2 });
    expect(byId.get('RQ-T')).not.toHaveProperty('recuts');
  });

  it('orders jobs by last ledger position and ignores malformed rows', () => {
    const text = [
      'not json',
      '[]',
      line({ event: 'launch', job: 'has space!', lane: 'codex' }),
      line({ event: 'launch', repo: 'ashlrai/phantom' }),
      launch('RQ-U'), launch('RQ-V'), outcome('RQ-U', 'CLOSED'), outcome('RQ-V', 'MERGED'),
      launch('RQ-W', 'bad lane!!'), outcome('RQ-W', 'MERGED'),
    ].join('\n');
    const jobs = skillNudgeJobsFromLedger(text);
    expect(jobs.map(job => job.id)).toEqual(['RQ-U', 'RQ-V', 'RQ-W']);
    // The launch's unparseable lane is rejected; the outcome row's valid lane wins.
    expect(jobs[2]).toMatchObject({ lane: 'codex', outcome: 'merged' });
  });
});

describe('syncSkillNudgesFromJobsLedger', () => {
  const NOW = () => new Date('2026-10-28T20:00:00.000Z');

  it('folds injected ledger text into persisted candidate cards', async () => {
    const failed = (id: string) => [
      launch(id, 'codex', `2026-10-28T10:0${id.slice(-1)}:00-0400`),
      finish(id, { failure_class: 'quota' }),
      outcome(id, 'CLOSED'),
    ];
    const mergedJob = [
      launch('RQ-REC', 'codex'), finish('RQ-REC', { failure_class: 'quota' }),
      launch('RQ-REC', 'codex', '2026-10-28T13:00:00-0400'), outcome('RQ-REC', 'MERGED'),
    ];
    const text = [...failed('RQ-F1'), ...failed('RQ-F2'), ...failed('RQ-F3'), ...mergedJob].join('\n');
    const result = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(result).toMatchObject({ state: 'read', truncated: false, folded: 4, candidates: 1 });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: 'candidate', source: 'imported',
      trigger: 'codex: recover from quota', sourceJobIds: ['RQ-F1', 'RQ-F2', 'RQ-F3', 'RQ-REC'] });
  });

  it('is idempotent across repeated syncs', async () => {
    const text = [launch('RQ-A'), launch('RQ-A'), outcome('RQ-A', 'MERGED')].join('\n');
    const first = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    const second = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(first.candidates).toBe(1);
    expect(second.candidates).toBe(0);
    expect(cards).toHaveLength(1);
  });

  it('reports degraded corpus as zero candidates without throwing', async () => {
    vi.mocked(readSkillCardCorpus).mockReturnValue({ cards: [], sourceState: 'degraded', sourcePresent: true,
      filesScanned: 0, unreadableFiles: 0, invalidRows: 0, bytesScanned: 0, limitExceeded: false });
    const text = [launch('RQ-A'), launch('RQ-A'), outcome('RQ-A', 'MERGED')].join('\n');
    const result = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(result).toMatchObject({ state: 'read', folded: 1, candidates: 0 });
    expect(cards).toHaveLength(0);
  });

  it('reports ledger read problems as state, never as an empty success', async () => {
    const runsDir = join(directory, 'runs-empty');
    const result = await syncSkillNudgesFromJobsLedger({ runsDir, now: NOW });
    expect(result).toMatchObject({ state: 'missing', folded: 0, candidates: 0 });
    expect(result.jobsPath).toBe(join(runsDir, 'metrics', 'jobs.jsonl'));
  });
});
