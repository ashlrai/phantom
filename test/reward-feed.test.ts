/** Inert fixtures only. No provider calls, native profiles or credentials. */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldJobsLedgerRewards, syncRewardSignalsFromJobsLedger } from '../src/core/metrics/reward-feed.js';
import { ROUTER_OUTCOME_LEDGER_LIMIT } from '../src/core/router/outcomes.js';
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
const ciStart = (job: string, ts: string) => line({ event: 'ci_start', job, ts });
const ciComplete = (job: string, ts: string) => line({ event: 'ci_complete', job, ts });

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

  it('keeps batch member rewards and excludes wrapper rewards for the same PR', () => {
    const batch = 'RQ-BATCH-17';
    const member = 'RQ-MEMBER17'; // Same length gives both verdict receipts the same PR URL.
    const rows = [launch(batch), batchClaim(member, batch), merged(batch), merged(member)];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toEqual([
      expect.objectContaining({ jobId: member, pool: 'claude', merged: true }),
    ]);
  });

  it.each(['fleet.session-pool.v1', 'phm-node-runner.v1'])(
    'does not pair a %s attempt receipt with a PR verdict', (schema) => {
      const job = 'ready:RQ-A:1:2';
      const attempt = line({ schema, event: 'launch', job, jobId: 'ready:RQ-A:1', ts: DISPATCH_ISO });
      expect(foldJobsLedgerRewards([attempt, merged(job)].join('\n'), NOW_MS)).toEqual([]);
    },
  );

  it('emits merged:false for a CLOSED-unmerged outcome', () => {
    const text = [claim('RQ-C'), closed('RQ-C')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toEqual([{
      jobId: 'RQ-C', pool: 'devin', repo: 'ashlrai/phantom',
      merged: false, dispatchedAt: '2026-10-28T13:00:00.000Z', mergedAt: null, costUsd: null,
    }]);
  });

  it('uses the latest dispatch before the outcome', () => {
    const retry = launch('RQ-D', 'codex-cmp', '2026-10-28T08:00:00-0400');
    const relaunch = launch('RQ-D', 'omlx', '2026-10-28T11:00:00-0400');
    const text = [retry, finish('RQ-D'), relaunch, merged('RQ-D')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ pool: 'omlx', dispatchedAt: '2026-10-28T15:00:00.000Z' });
  });

  it.each([
    [{ lane: ' UNKNOWN ', pool: 'devin', arm: 'claude' }, 'devin'],
    [{ lane: 'invalid lane', pool: 'unknown', arm: 'claude' }, 'claude'],
    [{ lane: 'codex-cmp', pool: 'devin' }, 'codex-cmp'],
    [{ lane: 'unknown', pool: 'UNKNOWN', arm: 'invalid lane' }, null],
  ])('uses the first observed lane on the latest dispatch (%j)', (fields, pool) => {
    const job = 'RQ-DISPATCH-ALIAS';
    const dispatch = line({ job, event: 'launch', ts: DISPATCH_ISO, ...fields });
    const text = [claim(job, 'older-pool'), dispatch, merged(job)].join('\n');
    expect(foldJobsLedgerRewards(text, NOW_MS)).toMatchObject([
      { jobId: job, pool, dispatchedAt: DISPATCH_ISO },
    ]);
  });

  it('withholds pool attribution when same-time dispatch aliases disagree', () => {
    const job = 'RQ-DISPATCH-CONFLICT';
    const dispatch = line({ job, event: 'claim', ts: DISPATCH_ISO, lane: 'unknown', pool: 'devin' });
    const text = [dispatch, launch(job, 'claude'), merged(job)].join('\n');
    expect(foldJobsLedgerRewards(text, NOW_MS)).toMatchObject([
      { jobId: job, pool: null, dispatchedAt: DISPATCH_ISO },
    ]);
  });

  it.each(['MERGED', 'CLOSED'])('uses the PR repository on the %s verdict', (state) => {
    const job = 'RQ-VERDICT-REPO';
    const verdict = line({
      job, state, repo: 'ashlrai/phantom', prUrl: 'https://github.com/AshlrAI/Lexicon/pull/12',
      ts: MERGED_ISO,
    });
    expect(foldJobsLedgerRewards([launch(job), verdict].join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, repo: 'ashlrai/lexicon' },
    ]);
  });

  it.each([
    { current: ['ashlrai/lexicon', 'AshlrAI/Lexicon', undefined], expected: 'ashlrai/lexicon' },
    { current: ['ashlrai/lexicon', 'ashlrai/locus'], expected: null },
    { current: [undefined], expected: null },
  ])('uses only repository evidence from the matching dispatch ($expected)', ({ current, expected }) => {
    const job = 'RQ-DISPATCH-REPO';
    const rows = [
      launch(job),
      ...current.map((repo) => line({ event: 'launch', job, repo, ts: '2026-10-28T15:00:00Z' })),
      line({ job, state: 'MERGED', mergedAt: MERGED_ISO, ts: '2026-10-28T15:35:00Z' }),
      launch(job, 'omlx', '2026-10-28T15:32:00Z'),
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, repo: expected },
    ]);
  });

  it.each([merged, closed])('leaves the pool unknown for conflicting latest dispatch lanes (%o)', (resolve) => {
    const job = 'RQ-TIED-DISPATCH';
    const dispatches = [claim(job, 'devin', DISPATCH_ISO), launch(job, 'codex-cmp', DISPATCH_ISO)];
    for (const rows of [dispatches, [...dispatches].reverse()]) {
      expect(foldJobsLedgerRewards([...rows, resolve(job)].join('\n'), NOW_MS)).toMatchObject([
        { jobId: job, pool: null, merged: resolve === merged, dispatchedAt: DISPATCH_ISO },
      ]);
    }
  });

  it('retains one observed lane among matching and unknown latest dispatch receipts', () => {
    const job = 'RQ-MATCHING-DISPATCH';
    const rows = [
      claim(job, 'unknown', DISPATCH_ISO),
      launch(job, 'codex-cmp', DISPATCH_ISO),
      claim(job, 'codex-cmp', DISPATCH_ISO),
      claim(job, 'devin'),
      merged(job),
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, pool: 'codex-cmp', dispatchedAt: DISPATCH_ISO },
    ]);
  });

  it.each(['closedAt', 'closed_at'])('binds a delayed close receipt to its PR close time (%s)', (field) => {
    const job = 'RQ-DELAYED-CLOSE';
    const rows = [
      launch(job),
      ciStart(job, '2026-10-28T15:55:00.000Z'),
      ciComplete(job, '2026-10-28T16:03:00.000Z'),
      line({ job, outcome: 'CLOSED', [field]: '2026-10-28T16:00:00.000Z', ts: '2026-10-28T16:10:00.000Z' }),
    ];

    const retry = launch(job, 'omlx', '2026-10-28T16:05:00.000Z');
    const inputs = foldJobsLedgerRewards([...rows, retry].join('\n'), NOW_MS);
    expect(inputs).toMatchObject([{ jobId: job, merged: false, pool: 'codex-cmp', dispatchedAt: DISPATCH_ISO }]);
    expect(inputs[0]).not.toHaveProperty('ciWallMs');
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)[0]).not.toHaveProperty('ciWallMs');
  });

  it('keeps a close timestamp after the observation window unresolved', () => {
    const job = 'RQ-FUTURE-CLOSE';
    const text = [
      launch(job),
      line({ job, outcome: 'CLOSED', closedAt: '2026-10-29T00:00:00.000Z', ts: '2026-10-28T16:10:00.000Z' }),
    ].join('\n');

    expect(foldJobsLedgerRewards(text, NOW_MS)).toEqual([]);
  });

  it.each([merged, closed])('ignores later dispatches when attributing a resolved PR (%o)', (resolve) => {
    const job = 'RQ-RELAUNCH';
    const text = [
      launch(job, 'claude', '2026-10-28T15:30:30.000Z'),
      launch(job, 'omlx', '2026-10-28T15:00:00.000Z'),
      resolve(job, MERGED_ISO),
      claim(job),
    ].join('\n');

    expect(foldJobsLedgerRewards(text, NOW_MS)).toMatchObject([
      { jobId: job, pool: 'omlx', dispatchedAt: '2026-10-28T15:00:00.000Z' },
    ]);
  });

  it.each([
    [merged, { event: 'launch' }],
    [closed, { type: 'claim', ts: 'unknown' }],
    [merged, { kind: 'batch_claim', ts: null }],
  ] as const)('withholds rewards when a dispatch cannot be ordered (%o, %j)', (resolve, receipt) => {
    const job = 'RQ-UNDATED-DISPATCH';
    const undated = line({ job, lane: 'claude', ...receipt });
    const other = 'RQ-OTHER';
    for (const rows of [[undated, launch(job), resolve(job)], [launch(job), resolve(job), undated]]) {
      expect(foldJobsLedgerRewards([...rows, launch(other), merged(other)].join('\n'), NOW_MS))
        .toMatchObject([{ jobId: other, pool: 'codex-cmp' }]);
    }
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

  it('keeps a merge reverted when its receipt is replayed later', () => {
    const job = 'RQ-REPLAY';
    const rows = [
      launch(job),
      merged(job),
      line({ event: 'revert', job, ts: '2026-10-28T17:00:00.000Z' }),
      merged(job, MERGED_ISO, '2026-10-28T19:00:00.000Z'),
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toEqual([
      expect.objectContaining({ jobId: job, merged: false, mergedAt: null, dispatchedAt: DISPATCH_ISO }),
    ]);
  });

  it('credits the later merge even when receipts for the earlier merge and revert arrive last', () => {
    const job = 'RQ-LATE-RECEIPTS';
    const dispatchAt = '2026-10-28T17:00:00.000Z';
    const mergeAt = '2026-10-28T18:00:00.000Z';
    const rows = [
      launch(job),
      launch(job, 'devin', dispatchAt),
      merged(job, mergeAt, '2026-10-28T18:01:00.000Z'),
      merged(job, MERGED_ISO, '2026-10-28T19:00:00.000Z'),
      line({ event: 'revert', job, revertedAt: '2026-10-28T16:30:00.000Z', ts: '2026-10-28T19:01:00.000Z' }),
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toEqual([
      expect.objectContaining({ jobId: job, pool: 'devin', merged: true, mergedAt: mergeAt, dispatchedAt: dispatchAt }),
    ]);
  });

  it.each([
    ['pr_url', 'https://github.com/ashlrai/phantom/pull/101', true],
    ['pr_url', 'https://github.com/AshlrAI/Phantom/pull/102/', false],
    ['html_url', 'https://github.com/ashlrai/phantom/pull/101', true],
    ['html_url', 'https://github.com/AshlrAI/Phantom/pull/102/', false],
    ['pr_url', 'https://github.com/ashlrai/phantom/issues/101', true],
  ] as const)('scopes a delayed revert with %s=%s to its PR', (alias, url, held) => {
    const job = 'RQ-REUSED-PR';
    const dispatchAt = '2026-10-28T16:00:00.000Z';
    const mergeAt = '2026-10-28T17:00:00.000Z';
    const rows = [
      launch(job),
      line({ job, state: 'MERGED', mergedAt: MERGED_ISO, url: 'https://github.com/ashlrai/phantom/pull/101' }),
      launch(job, 'devin', dispatchAt),
      line({ job, state: 'MERGED', mergedAt: mergeAt, url: 'https://github.com/ashlrai/phantom/pull/102' }),
      line({ job, event: 'reverted', [alias]: url, ts: '2026-10-28T18:00:00.000Z' }),
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, pool: 'devin', dispatchedAt: dispatchAt, merged: held, mergedAt: held ? mergeAt : null },
    ]);
  });

  it('uses html_url to scope ledger reverts and join standing reverts', () => {
    const job = 'RQ-HTML-URL';
    const rows = [
      launch(job),
      line({ job, state: 'MERGED', mergedAt: MERGED_ISO, html_url: 'https://github.com/ashlrai/companion/pull/102' }),
      line({ job, event: 'reverted', html_url: 'https://github.com/ashlrai/companion/pull/101', ts: '2026-10-28T18:00:00.000Z' }),
    ];
    const ledger = rows.join('\n');
    expect(foldJobsLedgerRewards(ledger, NOW_MS)).toMatchObject([
      { jobId: job, repo: 'ashlrai/companion', merged: true },
    ]);
    const reverted = new Set(['ashlrai/companion#102']);
    expect(foldJobsLedgerRewards(ledger, NOW_MS, undefined, reverted)).toMatchObject([
      { jobId: job, repo: 'ashlrai/companion', merged: false },
    ]);
    const contested = [...rows, line({ job: 'RQ-OTHER', html_url: 'https://github.com/ashlrai/companion/pull/102' })];
    expect(foldJobsLedgerRewards(contested.join('\n'), NOW_MS, undefined, reverted)).toMatchObject([
      { jobId: job, repo: 'ashlrai/companion', merged: true },
    ]);
  });

  it.each(['ledger', 'standing set'])('attributes a revert from the %s to the original merge attempt', (source) => {
    const job = 'RQ-REUSED';
    const original = launch(job);
    const later = [
      merged(job),
      launch(job, 'devin', '2026-10-28T16:00:00.000Z'),
      ciStart(job, '2026-10-28T16:15:00.000Z'),
      ciComplete(job, '2026-10-28T16:45:00.000Z'),
    ];
    if (source === 'ledger') {
      later.push(line({ event: 'reverted', job, ts: '2026-10-28T17:00:00.000Z' }));
    }
    const keys = source === 'standing set' ? new Set([`ashlrai/phantom#${job.length}`]) : undefined;
    const rows = [
      original,
      ciStart(job, '2026-10-28T14:30:00.000Z'),
      ciComplete(job, '2026-10-28T14:45:00.000Z'),
      ...later,
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS, undefined, keys)).toEqual([
      expect.objectContaining({ pool: 'codex-cmp', dispatchedAt: DISPATCH_ISO, merged: false, mergedAt: null, ciWallMs: 900_000 }),
    ]);
    expect(foldJobsLedgerRewards(later.join('\n'), NOW_MS, undefined, keys)).toEqual([]);
  });

  it('keeps a closed PR attributed to its original dispatch when a later revert arrives', () => {
    const job = 'RQ-CLOSED-REUSED';
    const later = [
      launch(job, 'devin', '2026-10-28T16:30:00.000Z'),
      ciStart(job, '2026-10-28T17:00:00.000Z'),
      ciComplete(job, '2026-10-28T17:30:00.000Z'),
      line({ event: 'reverted', job, url: 'https://github.com/ashlrai/phantom/pull/10', ts: '2026-10-28T18:00:00.000Z' }),
    ];
    const rows = [
      launch(job),
      ciStart(job, '2026-10-28T14:30:00.000Z'),
      ciComplete(job, '2026-10-28T14:45:00.000Z'),
      closed(job),
      ...later,
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, pool: 'codex-cmp', merged: false, dispatchedAt: DISPATCH_ISO, ciWallMs: 900_000 },
    ]);
    expect(foldJobsLedgerRewards([closed(job), ...later].join('\n'), NOW_MS)).toEqual([]);
    expect(foldJobsLedgerRewards(later.join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, pool: 'devin', merged: false, ciWallMs: 1_800_000 },
    ]);
  });

  it('discounts a held merge the standing revert set proves did not hold', () => {
    const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
    const merge = (job: string, n: number) =>
      line({ event: 'outcome', job, state: 'MERGED', url: pr(n), mergedAt: '2026-10-28T15:30:00.000Z', ts: '2026-10-28T15:31:00.000Z' });
    const text = [launch('RQ-R1'), merge('RQ-R1', 101), launch('RQ-R2'), merge('RQ-R2', 102)].join('\n');
    const keys = new Set(['ashlrai/phantom#101']);
    const inputs = foldJobsLedgerRewards(text, NOW_MS, undefined, keys);
    expect(inputs).toHaveLength(2);
    expect(inputs.find((i) => i.jobId === 'RQ-R1')).toMatchObject({ merged: false, mergedAt: null, dispatchedAt: DISPATCH_ISO });
    expect(inputs.find((i) => i.jobId === 'RQ-R2')).toMatchObject({ merged: true, mergedAt: MERGED_ISO });
    // Absent, empty or unmatched keys change nothing.
    for (const none of [undefined, null, new Set<string>(), new Set(['ashlrai/phantom#999'])]) {
      const held = foldJobsLedgerRewards(text, NOW_MS, undefined, none);
      expect(held.find((i) => i.jobId === 'RQ-R1')).toMatchObject({ merged: true });
    }
  });

  it('keeps a held merge when the standing revert claim is contested or foreign', () => {
    const pr = 'https://github.com/ashlrai/phantom/pull/101';
    const merge = (job: string) =>
      line({ event: 'outcome', job, state: 'MERGED', url: pr, mergedAt: '2026-10-28T15:30:00.000Z', ts: '2026-10-28T15:31:00.000Z' });
    // Two jobs claim the same PR URL: the revert cannot be attributed.
    const contested = [launch('RQ-R1'), merge('RQ-R1'), launch('RQ-R2'), merge('RQ-R2')].join('\n');
    const keys = new Set(['ashlrai/phantom#101']);
    const inputs = foldJobsLedgerRewards(contested, NOW_MS, undefined, keys);
    expect(inputs.find((i) => i.jobId === 'RQ-R1')).toMatchObject({ merged: true });
    expect(inputs.find((i) => i.jobId === 'RQ-R2')).toMatchObject({ merged: true });
    // A node-pool row carrying the same URL is a different dialect and never claims.
    const nodePool = line({ schema: 'phm-node-runner.v1', job: 'ready:RQ-X:1', state: 'MERGED', url: pr, ts: '2026-10-28T15:32:00.000Z' });
    const single = [launch('RQ-R1'), merge('RQ-R1'), nodePool].join('\n');
    const discounted = foldJobsLedgerRewards(single, NOW_MS, undefined, keys);
    expect(discounted.find((i) => i.jobId === 'RQ-R1')).toMatchObject({ merged: false });
  });

  it.each([
    'https://github.com/AshlrAI/Phantom/pull/101',
    'https://github.com/ashlrai/phantom/pull/101/',
  ])('checks standing revert claims across PR URL alias %s', (alias) => {
    const merge = line({
      job: 'RQ-R1', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/101',
      mergedAt: MERGED_ISO, ts: '2026-10-28T15:31:00.000Z',
    });
    const publish = (job: string) => line({ event: 'publish', job, url: alias, ts: DISPATCH_ISO });
    const rewards = (claimant: string) =>
      foldJobsLedgerRewards([launch('RQ-R1'), publish(claimant), merge].join('\n'), NOW_MS, undefined,
        new Set(['ashlrai/phantom#101']));
    expect(rewards('RQ-R1')).toEqual([expect.objectContaining({ jobId: 'RQ-R1', merged: false })]);
    expect(rewards('RQ-R2')).toEqual([expect.objectContaining({ jobId: 'RQ-R1', merged: true })]);
  });

  it('checks competing revert claims as of the observation time', () => {
    const url = 'https://github.com/ashlrai/phantom/pull/4';
    const claimAt = '2026-10-28T20:01:00.000Z';
    const keys = new Set(['ashlrai/phantom#4']);
    const observed = [launch('RQ-A'), merged('RQ-A')];
    const competitor = line({ event: 'publish', job: 'RQ-B', url, ts: claimAt });
    const text = [competitor, ...observed].join('\n');

    expect(foldJobsLedgerRewards(text, NOW_MS, undefined, keys))
      .toMatchObject([{ jobId: 'RQ-A', merged: false }]);
    expect(foldJobsLedgerRewards(text, Date.parse(claimAt), undefined, keys))
      .toMatchObject([{ jobId: 'RQ-A', merged: true }]);

    const undated = line({ event: 'publish', job: 'RQ-B', url });
    expect(foldJobsLedgerRewards([...observed, undated].join('\n'), NOW_MS, undefined, keys))
      .toMatchObject([{ jobId: 'RQ-A', merged: true }]);
  });

  it('lets a later fresh merge supersede a standing-reverted one', () => {
    const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
    const text = [
      launch('RQ-R1'),
      line({ event: 'outcome', job: 'RQ-R1', state: 'MERGED', url: pr(101), mergedAt: '2026-10-28T15:30:00.000Z', ts: '2026-10-28T15:31:00.000Z' }),
      line({ event: 'outcome', job: 'RQ-R1', state: 'MERGED', url: pr(105), mergedAt: '2026-10-28T18:00:00.000Z', ts: '2026-10-28T18:01:00.000Z' }),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS, undefined, new Set(['ashlrai/phantom#101']));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ merged: true, mergedAt: '2026-10-28T18:00:00.000Z' });
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

  it.each([
    ['MERGED', 'merged_at'],
    ['CLOSED', 'closedAt'],
  ])('bounds %s rewards by the epoch-millisecond resolution time', (state, field) => {
    const job = 'RQ-EPOCH';
    const resolution = '2026-10-28T15:00:00.000Z';
    const receipt = { event: 'outcome', job, state, ts: '2026-10-28T16:00:00Z' };
    const text = [
      launch(job),
      ciStart(job, '2026-10-28T14:10:00Z'),
      ciComplete(job, '2026-10-28T14:20:00Z'),
      launch(job, 'devin', '2026-10-28T15:30:00Z'),
      line({ ...receipt, [field]: Date.parse(resolution) }),
    ].join('\n');
    expect(foldJobsLedgerRewards(text, NOW_MS)).toMatchObject([{
      pool: 'codex-cmp', dispatchedAt: DISPATCH_ISO, ciWallMs: 600_000,
      merged: state === 'MERGED', mergedAt: state === 'MERGED' ? resolution : null,
    }]);
    const future = line({ ...receipt, [field]: NOW_MS + 1 });
    expect(foldJobsLedgerRewards([launch(job), future].join('\n'), NOW_MS)).toEqual([]);
  });

  it('orders a timestamp-only epoch-millisecond revert by its effective time', () => {
    const job = 'RQ-EPOCH-REVERT';
    const revert = (timestamp: number) => line({
      job, reverted_at: timestamp, ts: '2026-10-28T16:00:00Z',
    });
    for (const [at, held] of [
      [Date.parse(MERGED_ISO) - 1, true],
      [Date.parse(MERGED_ISO), false],
      [NOW_MS + 1, true],
    ] as const) {
      expect(foldJobsLedgerRewards([launch(job), merged(job), revert(at)].join('\n'), NOW_MS))
        .toMatchObject([{ merged: held, dispatchedAt: DISPATCH_ISO }]);
    }
  });

  it('reads merged/closed event names as verdicts when no phase field resolves', () => {
    const text = [
      launch('RQ-EV'),
      line({ event: 'merged', job: 'RQ-EV', url: 'https://github.com/ashlrai/phantom/pull/55', mergedAt: '2026-10-28T15:30:00.000Z', ts: '2026-10-28T15:31:00.000Z' }),
      claim('RQ-CL'),
      line({ event: 'closed', job: 'RQ-CL', url: 'https://github.com/ashlrai/phantom/pull/56', closedAt: '2026-10-28T16:00:00.000Z', ts: '2026-10-28T16:01:00.000Z' }),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(2);
    expect(inputs.find((i) => i.jobId === 'RQ-EV')).toMatchObject({ merged: true, mergedAt: MERGED_ISO });
    expect(inputs.find((i) => i.jobId === 'RQ-CL')).toMatchObject({ merged: false, mergedAt: null });
  });

  it('keeps a resolved phase authoritative over the event name', () => {
    const text = [
      launch('RQ-PH'),
      // A non-terminal phase blocks the 'merged' event verdict: still unresolved.
      line({ event: 'merged', job: 'RQ-PH', state: 'OPEN', ts: '2026-10-28T15:31:00.000Z' }),
      launch('RQ-PC'),
      // A CLOSED phase beats a 'merged' event name on the same row.
      line({ event: 'merged', job: 'RQ-PC', state: 'CLOSED', url: 'https://github.com/ashlrai/phantom/pull/57', closedAt: '2026-10-28T16:00:00.000Z', ts: '2026-10-28T16:01:00.000Z' }),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ jobId: 'RQ-PC', merged: false, mergedAt: null });
  });

  it('folds ci_start/ci_complete boundaries into ciWallMs on merged and closed rows', () => {
    const text = [
      launch('RQ-CI'),
      ciStart('RQ-CI', '2026-10-28T15:10:00.000Z'),
      ciComplete('RQ-CI', '2026-10-28T15:25:30.000Z'),
      merged('RQ-CI'),
      claim('RQ-CJ'),
      ciStart('RQ-CJ', '2026-10-28T15:40:00.000Z'),
      ciComplete('RQ-CJ', '2026-10-28T15:55:00.000Z'),
      closed('RQ-CJ'),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(2);
    expect(inputs.find((i) => i.jobId === 'RQ-CI')).toMatchObject({ merged: true, ciWallMs: 930_000 });
    expect(inputs.find((i) => i.jobId === 'RQ-CJ')).toMatchObject({ merged: false, ciWallMs: 900_000 });
  });

  it('leaves ciWallMs unknown for missing, ambiguous, reversed or future CI boundaries', () => {
    const text = [
      launch('RQ-NOSTART'), ciComplete('RQ-NOSTART', '2026-10-28T15:25:00.000Z'), merged('RQ-NOSTART'),
      launch('RQ-TWOSTART'),
      ciStart('RQ-TWOSTART', '2026-10-28T15:10:00.000Z'), ciStart('RQ-TWOSTART', '2026-10-28T15:11:00.000Z'),
      ciComplete('RQ-TWOSTART', '2026-10-28T15:25:00.000Z'), merged('RQ-TWOSTART'),
      launch('RQ-REVERSED'),
      ciStart('RQ-REVERSED', '2026-10-28T15:25:00.000Z'), ciComplete('RQ-REVERSED', '2026-10-28T15:10:00.000Z'),
      merged('RQ-REVERSED'),
      launch('RQ-FUTURE'),
      ciStart('RQ-FUTURE', '2026-10-28T15:10:00.000Z'), ciComplete('RQ-FUTURE', '2026-10-29T00:00:00.000Z'),
      merged('RQ-FUTURE'),
    ].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(4);
    for (const input of inputs) expect(input).not.toHaveProperty('ciWallMs');
  });

  it('withholds CI timing when an undated boundary could fall inside the rewarded dispatch', () => {
    const job = 'RQ-UNDATED-CI';
    const text = [
      launch(job),
      ciStart(job, '2026-10-28T15:10:00.000Z'),
      ciComplete(job, '2026-10-28T15:25:00.000Z'),
      ciComplete(job, 'invalid'),
      merged(job),
    ].join('\n');

    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ jobId: job, merged: true });
    expect(inputs[0]).not.toHaveProperty('ciWallMs');
  });

  it('dedupes a repeated identical CI boundary stamp', () => {
    const start = ciStart('RQ-DUP', '2026-10-28T15:10:00.000Z');
    const text = [launch('RQ-DUP'), start, start, ciComplete('RQ-DUP', '2026-10-28T15:25:00.000Z'), merged('RQ-DUP')].join('\n');
    const inputs = foldJobsLedgerRewards(text, NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ ciWallMs: 900_000 });
  });

  it.each([
    ['MERGED', 'outcome'],
    ['CLOSED', 'outcome'],
    ['MERGED', 'replay'],
    ['MERGED', 'alias'],
    ['MERGED', 'pair'],
  ])('withholds CI timing for a %s reward with a conflicting %s PR claim', (state, conflict) => {
    const job = 'RQ-CI-PR';
    const url = 'https://github.com/ashlrai/phantom/pull/10';
    const other = 'https://github.com/ashlrai/phantom/pull/11';
    const start = { event: 'ci_start', job, ts: '2026-10-28T15:10:00.000Z', pr_url: url };
    const rows = [
      launch(job),
      line(start),
      line({
        event: 'ci_complete', job, ts: '2026-10-28T15:25:00.000Z',
        html_url: conflict === 'pair' ? other : url,
      }),
      line({
        job, state, ts: MERGED_ISO,
        ...(conflict === 'pair' ? {} : { url: conflict === 'outcome' ? other : url }),
      }),
    ];
    if (conflict === 'replay') rows.push(line({ ...start, pr_url: other }));
    if (conflict === 'alias') rows.push(line({ ...start, html_url: other }));

    const inputs = foldJobsLedgerRewards(rows.join('\n'), NOW_MS);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ merged: state === 'MERGED' });
    expect(inputs[0]).not.toHaveProperty('ciWallMs');
  });

  it('measures CI across equivalent PR URLs and ignores out-of-window claims', () => {
    const job = 'RQ-CI-PR';
    const rows = [
      launch(job),
      line({ event: 'ci_start', job, ts: '2026-10-28T13:10:00.000Z', pr: 'https://github.com/ashlrai/phantom/pull/99' }),
      line({ event: 'ci_start', job, ts: '2026-10-28T15:10:00.000Z', pr_url: 'https://github.com/AshlrAI/Phantom/pull/10/' }),
      line({ event: 'ci_complete', job, ts: '2026-10-28T15:25:00.000Z', html_url: 'https://github.com/ashlrai/phantom/pull/10' }),
      line({ job, state: 'MERGED', ts: MERGED_ISO, url: 'https://github.com/ashlrai/phantom/pull/10' }),
    ];
    expect(foldJobsLedgerRewards(rows.join('\n'), NOW_MS)).toMatchObject([
      { jobId: job, merged: true, ciWallMs: 900_000 },
    ]);
  });

  it.each([merged, closed])('omits CI timing outside the rewarded dispatch and resolution (%o)', (resolve) => {
    const job = 'RQ-LIFECYCLE-CI';
    const rows = [
      launch(job),
      launch(job, 'omlx', '2026-10-28T15:00:00.000Z'),
      resolve(job, '2026-10-28T15:30:00.000Z'),
    ];
    const outsidePairs = [
      ['14:10:00', '14:25:00'], // previous attempt
      ['14:55:00', '15:25:00'], // spans the retry
      ['15:10:00', '15:30:30'], // completes after resolution, before the merge receipt
      ['15:35:00', '15:45:00'], // subsequent CI
    ] as const;
    for (const [start, complete] of outsidePairs) {
      const text = [
        ...rows,
        ciStart(job, `2026-10-28T${start}.000Z`),
        ciComplete(job, `2026-10-28T${complete}.000Z`),
      ].join('\n');
      const inputs = foldJobsLedgerRewards(text, NOW_MS);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ pool: 'omlx', dispatchedAt: '2026-10-28T15:00:00.000Z' });
      expect(inputs[0]).not.toHaveProperty('ciWallMs');
    }
  });

  it.each([merged, closed])('measures CI for a rewarded retry with other attempts in the ledger (%o)', (resolve) => {
    const job = 'RQ-RETRY-CI';
    const text = [
      launch(job),
      ciStart(job, '2026-10-28T14:10:00.000Z'),
      ciComplete(job, '2026-10-28T14:25:00.000Z'),
      launch(job, 'omlx', '2026-10-28T15:00:00.000Z'),
      ciStart(job, '2026-10-28T15:10:00.000Z'),
      ciComplete(job, '2026-10-28T15:25:00.000Z'),
      resolve(job, '2026-10-28T15:30:00.000Z'),
      ciStart(job, '2026-10-28T15:35:00.000Z'),
      ciComplete(job, '2026-10-28T15:45:00.000Z'),
    ].join('\n');
    expect(foldJobsLedgerRewards(text, NOW_MS)).toMatchObject([
      { jobId: job, pool: 'omlx', ciWallMs: 900_000 },
    ]);
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

  it('records a merge with unknown USD cost when earlier spend is outside the retained tail', async () => {
    writeJobs([launch('RQ-A'), merged('RQ-A')].join('\n'));
    writeSpend(line({ job: 'RQ-A', cost_usd: 2.5 }) + '\n');
    const path = join(runsDir, 'metrics', 'api-spend.jsonl');
    truncateSync(path, ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    appendFileSync(path, '\n' + line({ job: 'RQ-A', cost_usd: 1 }) + '\n');

    const result = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(result).toMatchObject({ state: 'read', spendState: 'read', recorded: 1 });
    expect(rewardRows()).toMatchObject([{ jobId: 'RQ-A', merged: true, cost: { costUsd: null } }]);
  });

  it('records a merge without a USD total when one attributed call has no price', async () => {
    writeJobs([launch('RQ-A'), merged('RQ-A')].join('\n'));
    writeSpend([
      line({ job_id: 'RQ-A', model: 'unpriced' }),
      line({ job: 'RQ-A', cost_usd: 2.5 }),
    ].join('\n'));

    const result = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(result).toMatchObject({ state: 'read', spendState: 'read', recorded: 1 });
    expect(rewardRows()).toMatchObject([{ jobId: 'RQ-A', merged: true, cost: { costUsd: null } }]);
  });

  it('folds a standing-reverted merge as merged:false when the caller supplies the revert set', async () => {
    // merged('RQ-A') claims https://github.com/ashlrai/phantom/pull/4.
    writeJobs([launch('RQ-A'), merged('RQ-A'), claim('RQ-C'), closed('RQ-C')].join('\n'));
    const out = await syncRewardSignalsFromJobsLedger({
      runsDir, home, now: NOW, revertedPrKeys: new Set(['ashlrai/phantom#4']),
    });
    expect(out.recorded).toBe(2);
    const rows = rewardRows();
    expect(rows.find((r) => r.jobId === 'RQ-A')).toMatchObject({ merged: false, mergedAt: null });
    expect(rows.find((r) => r.jobId === 'RQ-C')).toMatchObject({ merged: false, mergedAt: null });
  });

  it('writes a merge reward only after its effective timestamp is reached', async () => {
    const mergedAt = '2026-10-28T20:01:00.000Z';
    const laterDispatch = '2026-10-28T20:00:30.000Z';
    writeJobs([
      launch('RQ-A'),
      merged('RQ-A', mergedAt, '2026-10-28T19:59:00.000Z'),
      launch('RQ-A', 'claude', laterDispatch),
    ].join('\n'));

    const early = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(early.recorded).toBe(0);
    expect(rewardRows()).toEqual([]);

    const onTime = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: () => new Date(mergedAt) });
    expect(onTime.recorded).toBe(1);
    expect(rewardRows()).toMatchObject([
      { jobId: 'RQ-A', merged: true, mergedAt, dispatchedAt: laterDispatch, pool: 'claude' },
    ]);
  });

  it('writes measured ciWallMs into the reward row and leaves it null without boundaries', async () => {
    writeJobs([
      launch('RQ-A'),
      ciStart('RQ-A', '2026-10-28T15:10:00.000Z'),
      ciComplete('RQ-A', '2026-10-28T15:25:00.000Z'),
      merged('RQ-A'),
      claim('RQ-C'), closed('RQ-C'),
    ].join('\n'));
    const out = await syncRewardSignalsFromJobsLedger({ runsDir, home, now: NOW });
    expect(out.recorded).toBe(2);
    const rows = rewardRows();
    expect(rows.find((r) => r.jobId === 'RQ-A')!.ciWallMs).toBe(900_000);
    expect(rows.find((r) => r.jobId === 'RQ-C')!.ciWallMs).toBeNull();
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
