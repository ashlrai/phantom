/** Inert fixtures only. No provider calls, native profiles or credentials. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldJobsLedgerRewards, syncRewardSignalsFromJobsLedger } from '../src/core/metrics/reward-feed.js';
import {
  readRewardSignals, rewardSignalPath, writeRewardSignal, writeRewardSignals,
  type RewardSignalInput,
} from '../src/core/metrics/reward-signal.js';

const NOW_MS = Date.parse('2026-10-28T20:00:00.000Z');
const NOW = () => new Date(NOW_MS);
const DISPATCH_ISO = '2026-10-28T14:00:00.000Z'; // 10:00 -0400
const MERGED_ISO = '2026-10-28T15:30:00.000Z';

const line = (row: Record<string, unknown>): string => JSON.stringify(row);
const launch = (job: string, lane = 'codex-cmp', ts = '2026-10-28T10:00:00-0400') =>
  line({ event: 'launch', job, repo: 'ashlrai/phantom', lane, tier: 'work', ts });
const claim = (job: string, lane = 'devin', ts = '2026-10-28T09:00:00-0400') =>
  line({ event: 'claim', job, repo: 'ashlrai/phantom', lane, tier: 'mid', ts });
const batchClaim = (job: string, batch: string, ts = '2026-10-28T09:30:00-0400') =>
  line({ event: 'batch_claim', job, batch, repo: 'ashlrai/phantom', lane: 'claude', tier: 'fast', ts });
const merged = (job: string, at = '2026-10-28T15:30:00.000Z', ts = '2026-10-28T15:31:00.000Z') =>
  line({ event: 'outcome', job, state: 'MERGED', url: `https://github.com/ashlrai/phantom/pull/${job.length}`, mergedAt: at, ts });
const closed = (job: string, ts = '2026-10-28T16:00:00.000Z') =>
  line({ event: 'outcome', job, state: 'CLOSED', url: 'https://github.com/ashlrai/phantom/pull/9', closedAt: ts, ts });
const finish = (job: string) => line({ event: 'finish', job, lane: 'codex-cmp', wall_s: 60, exit_code: 0, ts: '2026-10-28T12:00:00-0400' });

let directory: string;
let runsDir: string;
let home: string;
let ledgerPath: string;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'reward-feed-')));
  chmodSync(directory, 0o700);
  runsDir = join(directory, 'runs');
  home = join(directory, 'home');
  mkdirSync(join(runsDir, 'metrics'), { recursive: true });
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  mkdirSync(join(home, 'metrics'), { recursive: true });
  chmodSync(runsDir, 0o700);
  chmodSync(home, 0o700);
  ledgerPath = rewardSignalPath(home);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const rewardRows = () => readRewardSignals(ledgerPath);

describe('foldJobsLedgerRewards', () => {
  it('emits a merged reward input from launch plus MERGED outcome', () => {
    const text = [launch('RQ-A'), finish('RQ-A'), merged('RQ-A')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS, new Map([['RQ-A', 1.5]]));
    expect(inputs).toEqual([{
      jobId: 'RQ-A', pool: 'codex-cmp', repo: 'ashlrai/phantom',
      merged: true, dispatchedAt: DISPATCH_ISO, mergedAt: MERGED_ISO, costUsd: 1.5,
    }]);
  });

  it('uses batch_claim as dispatch evidence for batch members', () => {
    const text = [batchClaim('RQ-B1', 'B-7'), merged('RQ-B1')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ jobId: 'RQ-B1', pool: 'claude', merged: true });
    expect(inputs[0]!.dispatchedAt).toBe('2026-10-28T13:30:00.000Z');
  });

  it('emits merged:false for a CLOSED-unmerged outcome', () => {
    const text = [claim('RQ-C'), closed('RQ-C')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toEqual([{
      jobId: 'RQ-C', pool: 'devin', repo: 'ashlrai/phantom',
      merged: false, dispatchedAt: '2026-10-28T13:00:00.000Z', mergedAt: null, costUsd: null,
    }]);
  });

  it('uses the latest dispatch before the outcome, earliest as fallback', () => {
    const retry = launch('RQ-D', 'codex-cmp', '2026-10-28T08:00:00-0400');
    const relaunch = launch('RQ-D', 'omlx', '2026-10-28T11:00:00-0400');
    const text = [retry, finish('RQ-D'), relaunch, merged('RQ-D')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ pool: 'omlx', dispatchedAt: '2026-10-28T15:00:00.000Z' });
  });

  it('skips jobs without dispatch evidence or without resolved outcomes', () => {
    const text = [
      merged('RQ-NODISP'),                                  // outcome but never dispatched in window
      launch('RQ-RUNNING'),                                  // dispatched, still in flight
      line({ event: 'outcome', job: 'RQ-NOOP', state: 'DONE-NOOP', launched: false, ts: '2026-10-28T12:00:00-0400' }),
      line({ event: 'outcome', job: 'RQ-OPEN', state: 'OPEN', ts: '2026-10-28T12:00:00-0400' }),
      line({ event: 'task_outcome', job: 'RQ-T', batch: 'B-1', outcome: 'done', ts: '2026-10-28T12:00:00-0400' }),
      line({ event: 'finish', job: 'RQ-T', exit_code: 1, ts: '2026-10-28T12:00:00-0400' }),
    ].join('\n');
    expect(foldJobsLedgerRewards(text, NOW_MS)).toEqual([]);
  });

  it('resolves merged-then-reverted as merged:false and a later merge as held', () => {
    const reverted = line({ event: 'outcome', job: 'RQ-E', state: 'REVERTED', reverted_at: '2026-10-28T17:00:00.000Z', ts: '2026-10-28T17:01:00.000Z' });
    const text = [launch('RQ-E'), merged('RQ-E'), reverted, launch('RQ-F'), merged('RQ-F'),
      line({ event: 'outcome', job: 'RQ-F', state: 'REVERTED', reverted_at: '2026-10-28T16:00:00.000Z', ts: '2026-10-28T16:01:00.000Z' }),
      merged('RQ-F', '2026-10-28T18:00:00.000Z', '2026-10-28T18:01:00.000Z')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(2);
    expect(inputs.find((i) => i.jobId === 'RQ-E')).toMatchObject({ merged: false, mergedAt: null });
    expect(inputs.find((i) => i.jobId === 'RQ-F')).toMatchObject({ merged: true, mergedAt: '2026-10-28T18:00:00.000Z' });
  });

  it('ignores rows stamped after now and derives repo from the PR URL', () => {
    const text = [
      line({ event: 'launch', job: 'RQ-G', repo: 'ashlrai/phantom', lane: 'codex-cmp', ts: '2026-10-28T10:00:00-0400' }),
      line({ event: 'outcome', job: 'RQ-G', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/77', mergedAt: '2026-10-28T15:30:00.000Z', ts: '2026-10-28T15:31:00.000Z' }),
      line({ event: 'outcome', job: 'RQ-G', state: 'CLOSED', ts: '2026-10-29T00:00:00.000Z' }), // future: ignored
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ merged: true, repo: 'ashlrai/phantom' });
  });

  it('keeps unknown pool and repo null rather than guessing', () => {
    const text = [
      line({ event: 'claim', job: 'RQ-H', lane: 'Not A Lane!', ts: '2026-10-28T09:00:00-0400' }),
      line({ event: 'outcome', job: 'RQ-H', state: 'CLOSED', ts: '2026-10-28T16:00:00.000Z' }),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ pool: null, repo: null, merged: false });
  });

  it('reads alias timestamp fields on dispatch and outcome rows', () => {
    const text = [
      line({ event: 'launch', job: 'RQ-ALIAS', repo: 'ashlrai/phantom', lane: 'codex-cmp', tier: 'work', recordedAt: '2026-10-28T10:00:00-0400' }),
      line({ event: 'outcome', job: 'RQ-ALIAS', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/88', updatedAt: '2026-10-28T15:31:00.000Z' }),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toEqual([{
      jobId: 'RQ-ALIAS', pool: 'codex-cmp', repo: 'ashlrai/phantom',
      merged: true, dispatchedAt: DISPATCH_ISO, mergedAt: '2026-10-28T15:31:00.000Z', costUsd: null,
    }]);
  });
});

describe('writeRewardSignals', () => {
  const input = (jobId: string, patch: Partial<RewardSignalInput> = {}): RewardSignalInput => ({
    jobId, pool: 'codex-cmp', repo: 'ashlrai/phantom', merged: true,
    dispatchedAt: DISPATCH_ISO, mergedAt: MERGED_ISO, ...patch,
  });

  it('appends a batch under one lock and replays as duplicates', () => {
    const first = writeRewardSignals([input('RQ-1'), input('RQ-2'), input('RQ-3')], { path: ledgerPath, now: NOW });
    expect(first.recorded).toHaveLength(3);
    expect(first.invalid).toEqual([]);
    expect(rewardRows()).toHaveLength(3);
    const again = writeRewardSignals([input('RQ-1'), input('RQ-2'), input('RQ-3')], { path: ledgerPath, now: NOW });
    expect(again.recorded).toEqual([]);
    expect(again.duplicates).toHaveLength(3);
    expect(rewardRows()).toHaveLength(3);
  });

  it('skips conflicting and invalid inputs while writing the rest', () => {
    writeRewardSignal(input('RQ-OLD'), { path: ledgerPath, now: NOW });
    const out = writeRewardSignals([
      input('RQ-OLD', { merged: false, mergedAt: null }),   // conflicts with recorded merged:true
      input('RQ-NEW'),
      input('bad job'),                                      // invalid jobId
    ], { path: ledgerPath, now: NOW });
    expect(out.conflicts).toEqual(['RQ-OLD']);
    expect(out.invalid).toEqual(['bad job']);
    expect(out.recorded.map((r) => r.jobId)).toEqual(['RQ-NEW']);
    expect(rewardRows().map((r) => r.jobId).sort()).toEqual(['RQ-NEW', 'RQ-OLD']);
  });

  it('returns an empty result for no inputs without touching the ledger', () => {
    const out = writeRewardSignals([], { path: ledgerPath, now: NOW });
    expect(out).toEqual({ recorded: [], duplicates: [], conflicts: [], invalid: [] });
    expect(rewardRows()).toEqual([]);
  });
});

describe('syncRewardSignalsFromJobsLedger', () => {
  const writeJobs = (text: string) => writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), text, { mode: 0o600 });
  const writeSpend = (text: string) => writeFileSync(join(runsDir, 'metrics', 'api-spend.jsonl'), text, { mode: 0o600 });

  it('folds the jobs and spend ledgers into reward rows, idempotently', async () => {
    writeJobs([launch('RQ-A'), merged('RQ-A'), claim('RQ-C'), closed('RQ-C')].join('\n'));
    writeSpend(line({ job: 'RQ-A', cost_usd: 2.5, ts: '2026-10-28T15:00:00.000Z' }) + '\n');
    const first = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(first.state).toBe('read');
    expect(first.spendState).toBe('read');
    expect(first.folded).toBe(2);
    expect(first.recorded).toBe(2);
    const rows = rewardRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.jobId === 'RQ-A')).toMatchObject({
      merged: true, pool: 'codex-cmp', repo: 'ashlrai/phantom',
      dispatchedAt: DISPATCH_ISO, mergedAt: MERGED_ISO, timeToMergeMs: 5_400_000,
    });
    expect(rows.find((r) => r.jobId === 'RQ-A')!.cost.costUsd).toBe(2.5);
    expect(rows.find((r) => r.jobId === 'RQ-C')).toMatchObject({ merged: false, mergedAt: null, timeToMergeMs: null });

    const second = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(second.folded).toBe(2);
    expect(second.skippedRecorded).toBe(2);
    expect(second.recorded).toBe(0);
    expect(rewardRows()).toHaveLength(2);
  });

  it('meters pool cost from the queue usage journal when present', async () => {
    writeJobs([launch('RQ-A', 'codex-cmp'), merged('RQ-A')].join('\n'));
    const reading = (pctUsed: number, at: string) => JSON.stringify({
      pool: 'codex-cmp', pctUsed, resetAt: '2026-11-02T12:00:00.000Z', source: 'codex-cmp-reader',
      fetchedAt: at, writtenAt: at, event: 'manual-reading', burnRatePctPerHour: null, projected100At: null, cutActive: false,
    });
    writeFileSync(join(runsDir, 'queue', 'usage-readings.log'),
      [reading(10, '2026-10-28T09:00:00.000Z'), reading(34, '2026-10-28T19:00:00.000Z')].join('\n') + '\n', { mode: 0o600 });
    const out = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(out.recorded).toBe(1);
    expect(rewardRows()[0]!.cost).toMatchObject({ pool: 'codex-cmp', pctUsedStart: 10, pctUsedEnd: 34, pctUsedDelta: 24 });
  });

  it('reports missing and unreadable ledgers without writing', async () => {
    const missing = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(missing.state).toBe('missing');
    expect(missing.recorded).toBe(0);
    writeJobs('not json at all\n{"event":"launch"}\n');
    const empty = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(empty.state).toBe('read');
    expect(empty.folded).toBe(0);
    expect(rewardRows()).toEqual([]);
  });

  it('never reconsiders an already-recorded jobId', async () => {
    writeRewardSignal({
      jobId: 'RQ-A', pool: 'codex-cmp', repo: 'ashlrai/phantom', merged: false,
      dispatchedAt: DISPATCH_ISO, mergedAt: null,
    }, { path: ledgerPath, now: NOW });
    writeJobs([launch('RQ-A'), merged('RQ-A')].join('\n'));
    const out = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(out.folded).toBe(1);
    expect(out.skippedRecorded).toBe(1);
    expect(out.recorded).toBe(0);
    expect(rewardRows()).toHaveLength(1);
    expect(rewardRows()[0]).toMatchObject({ merged: false });
  });
});
