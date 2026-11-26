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
  it('keeps the standing merge evidence when an unknown event follows it', () => {
    const job = 'RQ-RECOVERY';
    const text = [
      launch(job), launch(job), outcome(job, 'MERGED'),
      line({ event: 'constructor', job, lane: 'claude' }),
      line({ event: '__proto__', job: 'RQ-UNRESOLVED', lane: 'codex' }),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)).toEqual([
      { id: job, lane: 'codex', outcome: 'merged', retries: 1 },
      { id: 'RQ-UNRESOLVED', lane: 'codex' },
    ]);
  });

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

  it('reads the full jobs-ledger dialect: alias events, phase spellings and event-named outcomes', () => {
    const text = [
      // Reconciler-style merge: publish-shaped event, terminal phase in `phase`, alias stamp and PR link.
      launch('RQ-DIA1'),
      line({ type: 'publish', job: 'RQ-DIA1', phase: 'MERGED',
        pr_url: 'https://github.com/ashlrai/phantom/pull/42', recordedAt: '2026-10-28T15:30:00.000Z' }),
      // Closed outcome spelled `result` on a `kind` event.
      launch('RQ-DIA2'),
      line({ kind: 'outcome', job: 'RQ-DIA2', result: 'CLOSED',
        pr: 'https://github.com/ashlrai/phantom/pull/43', updatedAt: '2026-10-28T15:30:00.000Z' }),
      // Verdict carried only by the event name.
      launch('RQ-DIA3'),
      line({ event: 'merged', job: 'RQ-DIA3', lane: 'codex', ts: '2026-10-28T15:30:00.000Z' }),
      launch('RQ-DIA4'),
      line({ event: 'closed', job: 'RQ-DIA4', lane: 'codex', ts: '2026-10-28T15:30:00.000Z' }),
      // A bare outcome event names no verdict; a published row is not terminal.
      launch('RQ-DIA5'),
      line({ event: 'outcome', job: 'RQ-DIA5', lane: 'codex', ts: '2026-10-28T15:30:00.000Z' }),
      launch('RQ-DIA6'),
      line({ event: 'published', job: 'RQ-DIA6', outcome: 'PUBLISHED',
        url: 'https://github.com/ashlrai/phantom/pull/44', ts: '2026-10-28T15:30:00.000Z' }),
      // Phase stays authoritative over the event name.
      launch('RQ-DIA7'),
      line({ event: 'closed', job: 'RQ-DIA7', conclusion: 'MERGED', lane: 'codex', ts: '2026-10-28T15:30:00.000Z' }),
    ].join('\n');
    const byId = new Map(skillNudgeJobsFromLedger(text).map(job => [job.id, job]));
    expect(byId.get('RQ-DIA1')).toMatchObject({ outcome: 'merged' });
    expect(byId.get('RQ-DIA2')).toMatchObject({ outcome: 'failed' });
    expect(byId.get('RQ-DIA3')).toMatchObject({ outcome: 'merged' });
    expect(byId.get('RQ-DIA4')).toMatchObject({ outcome: 'failed' });
    expect(byId.get('RQ-DIA5')).not.toHaveProperty('outcome');
    expect(byId.get('RQ-DIA6')).not.toHaveProperty('outcome');
    expect(byId.get('RQ-DIA7')).toMatchObject({ outcome: 'merged' });
  });

  it('marks reverted merges without dropping the merged outcome', () => {
    const text = [
      launch('RQ-M'), outcome('RQ-M', 'MERGED'),
      line({ event: 'revert', job: 'RQ-M', lane: 'codex', ts: '2026-10-28T16:00:00.000Z' }),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)[0]).toMatchObject({ outcome: 'merged', reverted: true });
  });

  it('marks a merged job reverted when its unambiguous PR claim stands in the revert set', () => {
    const merge = (job: string, pr: number) => outcome(job, 'MERGED',
      { pr_url: `https://github.com/ashlrai/phantom/pull/${pr}` });
    const text = [
      launch('RQ-REV1'), merge('RQ-REV1', 777),
      launch('RQ-REV2'), merge('RQ-REV2', 778),
    ].join('\n');
    const keys = new Set(['ashlrai/phantom#777']);
    const byId = new Map(skillNudgeJobsFromLedger(text, keys).map(job => [job.id, job]));
    expect(byId.get('RQ-REV1')).toMatchObject({ outcome: 'merged', reverted: true });
    expect(byId.get('RQ-REV2')).toMatchObject({ outcome: 'merged' });
    expect(byId.get('RQ-REV2')).not.toHaveProperty('reverted');
    // No keys, an empty set and an unmatched key all leave the fold untouched.
    expect(skillNudgeJobsFromLedger(text)[0]).not.toHaveProperty('reverted');
    expect(skillNudgeJobsFromLedger(text, new Set())[0]).not.toHaveProperty('reverted');
    expect(skillNudgeJobsFromLedger(text, new Set(['ashlrai/phantom#999']))[0]).not.toHaveProperty('reverted');
  });

  it.each([
    'https://github.com/ashlrai/phantom/pull/779',
    'https://github.com/AshlrAI/Phantom/pull/779',
    'https://github.com/ashlrai/phantom/pull/779/',
  ])('never discounts a contested PR claim through %s', (competingUrl) => {
    const url = 'https://github.com/ashlrai/phantom/pull/779';
    const text = [
      launch('RQ-C1'), launch('RQ-C2'),
      outcome('RQ-C1', 'MERGED', { pr_url: url }),
      line({ event: 'publish', job: 'RQ-C2', pr_url: competingUrl, ts: '2026-10-28T15:30:00.000Z' }),
    ].join('\n');
    const byId = new Map(skillNudgeJobsFromLedger(text, new Set(['ashlrai/phantom#779']))
      .map(job => [job.id, job]));
    expect(byId.get('RQ-C1')).toMatchObject({ outcome: 'merged' });
    expect(byId.get('RQ-C1')).not.toHaveProperty('reverted');
  });

  it('binds the revert join to the standing verdict row, not earlier PR references', () => {
    const text = [
      launch('RQ-ERA'), outcome('RQ-ERA', 'MERGED',
        { pr_url: 'https://github.com/ashlrai/phantom/pull/780' }),
      launch('RQ-ERA'), outcome('RQ-ERA', 'MERGED',
        { pr_url: 'https://github.com/ashlrai/phantom/pull/781' }),
    ].join('\n');
    const [job] = skillNudgeJobsFromLedger(text, new Set(['ashlrai/phantom#780']));
    expect(job).toMatchObject({ outcome: 'merged' });
    expect(job).not.toHaveProperty('reverted');
  });

  it('excludes batch sessions and node-pool rows from the recovery fold and PR claims', () => {
    const url = 'https://github.com/ashlrai/phantom/pull/782';
    const text = [
      launch('RQ-BATCH-9'), launch('RQ-BATCH-9'),
      outcome('RQ-BATCH-9', 'MERGED', { pr_url: url }),
      line({ schema: 'fleet.session-pool.v1', job: 'sess:1', jobId: 'ready:x', pr_url: url,
        ts: '2026-10-28T10:00:00-0400' }),
      line({ schema: 'phm-node-runner.v1', event: 'finish', job: 'node:1', jobId: 'RQ-POOL',
        outcome: 'failed' }),
      line({ event: 'batch_claim', job: 'RQ-POOL', batch: 'RQ-BATCH-9', lane: 'codex' }),
      outcome('RQ-POOL', 'MERGED', { pr_url: url }),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text, new Set(['ashlrai/phantom#782']))).toEqual([
      { id: 'RQ-POOL', lane: 'codex', outcome: 'merged', reverted: true },
    ]);
  });

  it('does not mark non-merged outcomes reverted through the standing set', () => {
    const text = [
      launch('RQ-NM'),
      outcome('RQ-NM', 'CLOSED', { pr_url: 'https://github.com/ashlrai/phantom/pull/783' }),
    ].join('\n');
    const [job] = skillNudgeJobsFromLedger(text, new Set(['ashlrai/phantom#783']));
    expect(job).toMatchObject({ outcome: 'failed' });
    expect(job).not.toHaveProperty('reverted');
  });

  it('uses the last execution-side lane and ignores queue hints', () => {
    const text = [
      enqueue('RQ-N', 'fast'), launch('RQ-N', 'codex'),
      finish('RQ-N', {}, 'devin'),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)[0]).toMatchObject({ lane: 'devin' });
  });

  it('uses observed failure classifications through aliases and later unknown values', () => {
    expect(skillNudgeJobsFromLedger([
      finish('RQ-A', { failure_class: 'UNKNOWN', failure_reason: 'quota' }),
      finish('RQ-A', { failure_class: 'unknown' }),
      outcome('RQ-A', 'MERGED'),
      finish('RQ-B', { failure_class: 'unknown' }),
      outcome('RQ-B', 'CLOSED'),
    ].join('\n'))).toEqual([
      { id: 'RQ-A', lane: 'codex', outcome: 'merged', failureClass: 'quota' },
      { id: 'RQ-B', lane: 'codex', outcome: 'failed' },
    ]);
  });

  it('uses eventless terminal lane evidence and preserves known lanes through unknown values', () => {
    const text = [
      enqueue('RQ-N1', 'fast'),
      line({ job: 'RQ-N1', state: 'MERGED', pool: 'devin' }),
      launch('RQ-N2', 'codex'),
      line({ job: 'RQ-N2', state: 'MERGED', lane: 'unknown' }),
      enqueue('RQ-N3', 'fast'),
      line({ job: 'RQ-N3', state: 'MERGED' }),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)).toEqual([
      { id: 'RQ-N1', lane: 'devin', outcome: 'merged' },
      { id: 'RQ-N2', lane: 'codex', outcome: 'merged' },
      { id: 'RQ-N3', lane: 'unknown', outcome: 'merged' },
    ]);
  });

  it('ignores enqueued lane hints and uses the first observed execution lane alias', () => {
    const text = [
      line({ job: 'RQ-N4', event: 'launch', lane: 'UNKNOWN', pool: 'codex', arm: 'devin' }),
      line({ job: 'RQ-N4', type: 'enqueued', lane: 'fast' }),
      line({ job: 'RQ-N4', state: 'MERGED' }),
      line({ job: 'RQ-N5', kind: 'enqueued', pool: 'fast' }),
      line({ job: 'RQ-N5', state: 'MERGED' }),
      line({ job: 'RQ-N6', state: 'MERGED', lane: 'unknown', pool: 'unknown', arm: 'devin' }),
    ].join('\n');
    expect(skillNudgeJobsFromLedger(text)).toEqual([
      { id: 'RQ-N4', lane: 'codex', outcome: 'merged' },
      { id: 'RQ-N5', lane: 'unknown', outcome: 'merged' },
      { id: 'RQ-N6', lane: 'devin', outcome: 'merged' },
    ]);
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

  it('counts dispatched recuts once despite repeated admission checks', () => {
    const ready = line({ event: 'recut_admission', job: 'RQ-S', repo: 'phantom', action: 'ready', reason: 'recut-no-current-coverage', repeatOf: null, ts: '2026-10-28T11:00:00-0400' });
    const text = [
      line({ event: 'batch_claim', job: 'RQ-R', batch: 'B-3', repo: 'ashlrai/phantom', lane: 'claude', tier: 'fast', ts: '2026-10-28T10:00:00-0400' }),
      line({ event: 'batch_claim', job: 'RQ-R', batch: 'B-4', repo: 'ashlrai/phantom', lane: 'claude', tier: 'fast', ts: '2026-10-28T11:00:00-0400' }),
      line({ event: 'recut_admission', job: 'RQ-S', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT1L1', ts: '2026-10-28T10:00:00-0400' }),
      ready, ready, claim('RQ-S', 'codex', '2026-10-28T11:01:00-0400'),
      launch('RQ-S', 'codex', '2026-10-28T11:02:00-0400'),
      line({ event: 'recut_admission', job: 'RQ-T', repo: 'phantom', action: 'skip', reason: 'recut-already-merged', repeatOf: 'RQ-PHX-RECUT2L1', ts: '2026-10-28T10:00:00-0400' }),
      launch('RQ-T'),
      outcome('RQ-R', 'MERGED'), outcome('RQ-S', 'MERGED'), outcome('RQ-T', 'MERGED'),
    ].join('\n');
    const byId = new Map(skillNudgeJobsFromLedger(text).map(job => [job.id, job]));
    expect(byId.get('RQ-R')).toMatchObject({ outcome: 'merged', retries: 1 });
    expect(byId.get('RQ-S')).toEqual({ id: 'RQ-S', lane: 'codex', outcome: 'merged', recuts: 1 });
    expect(byId.get('RQ-T')).not.toHaveProperty('recuts');
  });

  it('orders resolved jobs by latest terminal outcome and ignores malformed rows', () => {
    const text = [
      'not json',
      '[]',
      line({ event: 'launch', job: 'has space!', lane: 'codex' }),
      line({ event: 'launch', repo: 'ashlrai/phantom' }),
      launch('RQ-U'), launch('RQ-V'), outcome('RQ-U', 'CLOSED'), outcome('RQ-V', 'MERGED'),
      launch('RQ-W', 'bad lane!!'), outcome('RQ-W', 'MERGED'),
      enqueue('RQ-U', 'fast'),
    ].join('\n');
    const jobs = skillNudgeJobsFromLedger(text);
    expect(jobs.map(job => job.id)).toEqual(['RQ-U', 'RQ-V', 'RQ-W']);
    // The launch's unparseable lane is rejected; the outcome row's valid lane wins.
    expect(jobs[2]).toMatchObject({ lane: 'codex', outcome: 'merged' });
  });

  it('binds recovery evidence to the latest terminal row in ledger order', () => {
    const retry = (job: string) => [
      line({ job, event: 'recut_admission', action: 'ready' }),
      launch(job, 'devin'),
      finish(job, { failure_class: 'quota' }, 'devin'),
    ];
    const text = [
      launch('RQ-MERGED'), outcome('RQ-MERGED', 'MERGED'), ...retry('RQ-MERGED'),
      launch('RQ-RETRIED'), outcome('RQ-RETRIED', 'CLOSED'), ...retry('RQ-RETRIED'),
      line({ job: 'RQ-RETRIED', state: 'MERGED' }),
    ].join('\n');

    expect(skillNudgeJobsFromLedger(text)).toEqual([
      { id: 'RQ-MERGED', lane: 'codex', outcome: 'merged' },
      { id: 'RQ-RETRIED', lane: 'devin', outcome: 'merged', retries: 1, recuts: 1, failureClass: 'quota' },
    ]);
  });
});

describe('syncSkillNudgesFromJobsLedger', () => {
  const NOW = () => new Date('2026-10-28T20:00:00.000Z');

  it.each(['ts', 'mergedAt'])('waits for a merge with a future %s', async field => {
    const job = 'RQ-REC';
    const future = '2026-10-28T21:00:00.000Z';
    const text = [launch(job), launch(job), outcome(job, 'MERGED', { [field]: future })].join('\n');

    const early = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(early.candidates).toBe(0);
    expect(cards).toHaveLength(0);
    const observed = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: () => new Date(future) });
    expect(observed.candidates).toBe(1);
    expect(cards[0]?.sourceJobIds).toEqual([job]);
  });

  it.each([true, false])('uses terminal outcome order for recurrence (third failure before merge: %s)', async beforeMerge => {
    const firstFailures = ['RQ-F1', 'RQ-F2'].flatMap(id => [
      launch(id), finish(id, { failure_class: 'quota' }), outcome(id, 'CLOSED'),
    ]);
    const thirdFailure = outcome('RQ-F3', 'CLOSED');
    const merge = outcome('RQ-REC', 'MERGED');
    const text = [
      ...firstFailures,
      launch('RQ-F3'), finish('RQ-F3', { failure_class: 'quota' }),
      launch('RQ-REC'), finish('RQ-REC', { failure_class: 'quota', exit_code: 0 }),
      ...(beforeMerge ? [thirdFailure, merge, enqueue('RQ-F3')] : [merge, thirdFailure, enqueue('RQ-REC')]),
    ].join('\n');

    await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });

    expect(cards.map(card => card.sourceJobIds)).toEqual(beforeMerge ? [['RQ-F1', 'RQ-F2', 'RQ-F3', 'RQ-REC']] : []);
  });

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

  it('does not persist recut drafts from admission receipts without a matching dispatch', async () => {
    const admission = (job: string, action: string) => line({ job, event: 'recut_admission', action });
    const text = [
      admission('RQ-DEFER', 'defer'), launch('RQ-DEFER'), outcome('RQ-DEFER', 'MERGED'),
      launch('RQ-LATE'), admission('RQ-LATE', 'ready'), outcome('RQ-LATE', 'MERGED'),
      admission('RQ-STALE', 'ready'), outcome('RQ-STALE', 'CLOSED'),
      launch('RQ-STALE'), outcome('RQ-STALE', 'MERGED'),
      admission('RQ-BLOCKED', 'ready'), admission('RQ-BLOCKED', 'defer'),
      launch('RQ-BLOCKED'), outcome('RQ-BLOCKED', 'MERGED'),
    ].join('\n');
    const result = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(result).toMatchObject({ state: 'read', folded: 4, candidates: 0 });
    expect(cards).toEqual([]);
  });

  it('reports degraded corpus as zero candidates without throwing', async () => {
    vi.mocked(readSkillCardCorpus).mockReturnValue({ cards: [], sourceState: 'degraded', sourcePresent: true,
      filesScanned: 0, unreadableFiles: 0, invalidRows: 0, bytesScanned: 0, limitExceeded: false });
    const text = [launch('RQ-A'), launch('RQ-A'), outcome('RQ-A', 'MERGED')].join('\n');
    const result = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(result).toMatchObject({ state: 'read', folded: 1, candidates: 0 });
    expect(cards).toHaveLength(0);
  });

  it('withholds candidates whose merged recovery PR stands reverted', async () => {
    const failed = (id: string) => [
      launch(id, 'codex', `2026-10-28T10:0${id.slice(-1)}:00-0400`),
      finish(id, { failure_class: 'quota' }),
      outcome(id, 'CLOSED'),
    ];
    const mergedJob = [
      launch('RQ-REC', 'codex'), finish('RQ-REC', { failure_class: 'quota' }),
      launch('RQ-REC', 'codex', '2026-10-28T13:00:00-0400'),
      outcome('RQ-REC', 'MERGED', { pr_url: 'https://github.com/ashlrai/phantom/pull/790' }),
    ];
    const text = [...failed('RQ-G1'), ...failed('RQ-G2'), ...failed('RQ-G3'), ...mergedJob].join('\n');
    const reverted = await syncSkillNudgesFromJobsLedger({
      jobsText: text, now: NOW, revertedPrKeys: new Set(['ashlrai/phantom#790']),
    });
    expect(reverted).toMatchObject({ state: 'read', folded: 4, candidates: 0 });
    expect(cards).toHaveLength(0);
    // The same ledger without the standing key still seeds the draft.
    const held = await syncSkillNudgesFromJobsLedger({ jobsText: text, now: NOW });
    expect(held.candidates).toBe(1);
    expect(cards).toHaveLength(1);
  });

  it('reports ledger read problems as state, never as an empty success', async () => {
    const runsDir = join(directory, 'runs-empty');
    const result = await syncSkillNudgesFromJobsLedger({ runsDir, now: NOW });
    expect(result).toMatchObject({ state: 'missing', folded: 0, candidates: 0 });
    expect(result.jobsPath).toBe(join(runsDir, 'metrics', 'jobs.jsonl'));
  });
});
