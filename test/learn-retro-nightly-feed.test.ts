import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOUD_SEAT_ID, CLOUD_TASK_SCHEMA_VERSION, type CloudTaskV1 } from '../src/core/cloud/types.js';
import { DEVIN_TASK_SCHEMA_VERSION, type DevinTaskV1 } from '../src/core/devin/types.js';
import {
  ensureNightlyInputs, foldCloudTasks, foldDevinTasks, foldFleetJobs,
  type NightlyReviewInput,
} from '../src/core/learn/retro/feed.js';
import { runNightlyRetro } from '../src/core/learn/retro/nightly.js';
import { learnHome, readNightlyState } from '../src/core/learn/retro/store.js';
import type { NightlyJob } from '../src/core/learn/retro/nightly-types.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');
const ENABLED = { foundry: { selfImprove: true } };
let home: string;
let runsDir: string;

function inputPath(name = 'jobs.jsonl'): string {
  return join(learnHome(), 'retro-input', name);
}

function ledgerPath(): string {
  return join(runsDir, 'metrics', 'jobs.jsonl');
}

async function writeLedger(rows: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(join(runsDir, 'metrics'), { recursive: true, mode: 0o700 });
  await writeFile(ledgerPath(), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
}

/** A minimal valid terminal fleet row; overrides win. */
function fleetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'outcome', job: 'RQ-TEST-1', repo: 'ashlrai/phantom', lane: 'work',
    state: 'MERGED', ts: '2026-10-25T23:00:00.000Z', ...overrides,
  };
}

/** A terminal cloud task; overrides win. Defaults to a merged task with no review evidence. */
function cloudTask(overrides: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  return {
    v: CLOUD_TASK_SCHEMA_VERSION, id: 'ct_20261025T200000Z_abc123', repo: 'ashlrai/phantom',
    baseBranch: 'master', branch: 'ashlr-cloud/ct_20261025T200000Z_abc123', title: 'task',
    prompt: 'do the thing', origin: 'self-improve', requestedBy: 'self-improve',
    seat: CLOUD_SEAT_ID, sessionId: 'sess-1', sessionUrl: null,
    state: 'merged', stateReason: null, failure: null,
    createdAt: '2026-10-25T20:00:00.000Z', launchedAt: '2026-10-25T20:01:00.000Z',
    updatedAt: '2026-10-25T23:00:00.000Z', pr: null, report: null,
    estimatedCostUsd: 3, backlogItemId: null, needsYouId: null,
    ...overrides,
  };
}

/** A terminal Devin task; overrides win. Defaults to a merged normal-mode task. */
function devinTask(overrides: Partial<DevinTaskV1> = {}): DevinTaskV1 {
  return {
    v: DEVIN_TASK_SCHEMA_VERSION, id: 'dv_20261025T200000Z_def456', repo: 'ashlrai/phantom',
    baseBranch: 'master', branch: 'ashlr-devin/dv_20261025T200000Z_def456', title: 'task',
    prompt: 'do the thing', origin: 'operator', requestedBy: 'mason',
    sessionId: 'dv-sess-1', sessionUrl: null,
    state: 'merged', stateReason: null, failure: null,
    createdAt: '2026-10-25T20:00:00.000Z', launchedAt: '2026-10-25T20:01:00.000Z',
    updatedAt: '2026-10-25T23:00:00.000Z', session: null,
    maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null,
    backlogItemId: null,
    ...overrides,
  };
}

async function readReviewsInput(): Promise<NightlyReviewInput[]> {
  const raw = await readFile(inputPath('review-blocks.jsonl'), 'utf8');
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as NightlyReviewInput);
}

async function readJobsInput(): Promise<NightlyJob[]> {
  const raw = await readFile(inputPath(), 'utf8');
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as NightlyJob);
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'phantom-nightly-feed-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  runsDir = join(home, 'runs');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('foldFleetJobs', () => {
  it('emits only terminal jobs with proven repo and arm, latest observation wins', () => {
    const rows = [
      fleetRow({ event: 'enqueue', state: undefined, ts: '2026-10-25T20:00:00.000Z' }),
      fleetRow({ event: 'launch', state: undefined, lane: 'work', ts: '2026-10-25T21:00:00.000Z' }),
      fleetRow({ state: 'MERGED', ts: '2026-10-25T22:00:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-2', state: 'FAILED', failed: true, ts: '2026-10-25T22:30:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-3', state: 'CANCELLED', ts: '2026-10-25T22:40:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-4', state: 'DONE-NOOP', ts: '2026-10-25T22:50:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-5', state: 'RUNNING', ts: '2026-10-25T23:10:00.000Z' }),
    ];
    const jobs = foldFleetJobs(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', NOW);
    expect(jobs).toEqual([
      { v: 1, id: 'RQ-TEST-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T22:00:00.000Z' },
      { v: 1, id: 'RQ-TEST-2', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'failed', updatedAt: '2026-10-25T22:30:00.000Z' },
      { v: 1, id: 'RQ-TEST-3', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'cancelled', updatedAt: '2026-10-25T22:40:00.000Z' },
    ]);
  });

  it('counts a later revert as failure and skips rows without provable attribution', () => {
    const rows = [
      fleetRow({ state: 'MERGED', ts: '2026-10-25T22:00:00.000Z' }),
      fleetRow({ state: 'REVERTED', reverted: true, ts: '2026-10-25T23:30:00.000Z' }),
      fleetRow({ job: 'RQ-NO-REPO', repo: 'phantom', lane: 'work' }),
      fleetRow({ job: 'RQ-NO-ARM', lane: undefined, model: undefined, arm: undefined }),
      fleetRow({ job: 'RQ-FUTURE', ts: '2026-10-27T00:00:00.000Z' }),
      fleetRow({ job: 'bad id!', state: 'MERGED' }),
    ];
    const jobs = foldFleetJobs(rows.map((row) => JSON.stringify(row)).join('\n'), NOW);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'RQ-TEST-1', status: 'failed', updatedAt: '2026-10-25T23:30:00.000Z' });
  });

  it('counts the shared revert vocabulary — event names and reverted_at stamps — as failure', () => {
    const rows = [
      // A revert recorded by event name carries no terminal state field.
      fleetRow({ job: 'RQ-REV-EVENT', state: 'MERGED', ts: '2026-10-25T22:00:00.000Z' }),
      fleetRow({ job: 'RQ-REV-EVENT', event: 'revert', state: undefined, ts: '2026-10-25T23:00:00.000Z' }),
      // A reverted_at stamp on an otherwise merged row is revert evidence.
      fleetRow({ job: 'RQ-REV-STAMP', state: 'MERGED', reverted_at: '2026-10-25T22:00:00.000Z', ts: '2026-10-25T22:30:00.000Z' }),
      // Merge and revert evidence on one row: the merge did not hold.
      fleetRow({ job: 'RQ-REV-BOTH', state: 'MERGED', merged: true, reverted: true, ts: '2026-10-25T23:10:00.000Z' }),
      // Explicit reverted:false is not evidence.
      fleetRow({ job: 'RQ-NO-REV', state: 'MERGED', reverted: false, ts: '2026-10-25T23:20:00.000Z' }),
      // A stale revert does not override a newer merge.
      fleetRow({ job: 'RQ-REV-OLD', event: 'revert', state: undefined, ts: '2026-10-25T21:00:00.000Z' }),
      fleetRow({ job: 'RQ-REV-OLD', state: 'MERGED', ts: '2026-10-25T22:00:00.000Z' }),
    ];
    const jobs = foldFleetJobs(rows.map((row) => JSON.stringify(row)).join('\n'), NOW);
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(byId.get('RQ-REV-EVENT')).toMatchObject({ status: 'failed', updatedAt: '2026-10-25T23:00:00.000Z' });
    expect(byId.get('RQ-REV-STAMP')).toMatchObject({ status: 'failed', updatedAt: '2026-10-25T22:30:00.000Z' });
    expect(byId.get('RQ-REV-BOTH')).toMatchObject({ status: 'failed' });
    expect(byId.get('RQ-NO-REV')).toMatchObject({ status: 'succeeded' });
    expect(byId.get('RQ-REV-OLD')).toMatchObject({ status: 'succeeded', updatedAt: '2026-10-25T22:00:00.000Z' });
  });

  it('derives repo from a GitHub PR URL and arm from model when no lane exists', () => {
    const jobs = foldFleetJobs(JSON.stringify(fleetRow({
      repo: undefined, lane: undefined, model: 'swe-2',
      url: 'https://github.com/ashlrai/phantom/pull/1234',
    })) + '\n', NOW);
    expect(jobs).toEqual([
      { v: 1, id: 'RQ-TEST-1', repo: 'ashlrai/phantom', arm: 'model:swe-2', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T23:00:00.000Z' },
    ]);
  });

  it('reads alias timestamp fields on terminal rows', () => {
    const jobs = foldFleetJobs([
      fleetRow({ ts: undefined, recordedAt: '2026-10-25T23:00:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-2', state: 'FAILED', failed: true, ts: undefined, updatedAt: '2026-10-25T22:30:00.000Z' }),
    ].map((row) => JSON.stringify(row)).join('\n'), NOW);
    expect(jobs).toEqual([
      { v: 1, id: 'RQ-TEST-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T23:00:00.000Z' },
      { v: 1, id: 'RQ-TEST-2', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'failed', updatedAt: '2026-10-25T22:30:00.000Z' },
    ]);
  });
});

describe('foldCloudTasks', () => {
  it('emits terminal tasks as jobs and recorded changes-requested verdicts as review rows', () => {
    const { jobs, reviews } = foldCloudTasks([
      cloudTask({
        id: 'ct_merged', state: 'merged',
        outcome: {
          observedAt: '2026-10-25T23:00:00.000Z', headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
          ci: 'success', failedChecks: [], reviewDecision: 'CHANGES_REQUESTED', changesRequested: 2,
        },
        pr: { number: 42, url: 'https://github.com/ashlrai/phantom/pull/42', state: 'merged', draft: false, title: 't' },
        playbookRef: { id: 'pb-nightly', version: 1, sha: 'c'.repeat(64) },
      }),
      cloudTask({ id: 'ct_closed', state: 'closed', updatedAt: '2026-10-25T22:00:00.000Z' }),
      cloudTask({ id: 'ct_running', state: 'running' }),
      cloudTask({ id: 'ct_reverted', state: 'merged', outcome: { observedAt: '2026-10-25T21:00:00.000Z', headSha: null, mergeSha: null, ci: null, failedChecks: [], reviewDecision: 'APPROVED', changesRequested: 0, revertedBy: 'd'.repeat(40) } }),
      cloudTask({ id: 'ct_superseded', state: 'closed', supersededBy: { repo: 'ashlrai/phantom', number: 7 } }),
    ], NOW);

    expect(jobs).toEqual([
      { v: 1, id: 'ct_closed', repo: 'ashlrai/phantom', arm: `cloud:${CLOUD_SEAT_ID}`, playbook: null, status: 'failed', updatedAt: '2026-10-25T22:00:00.000Z' },
      { v: 1, id: 'ct_merged', repo: 'ashlrai/phantom', arm: `cloud:${CLOUD_SEAT_ID}`, playbook: 'pb-nightly', status: 'succeeded', updatedAt: '2026-10-25T23:00:00.000Z' },
      { v: 1, id: 'ct_reverted', repo: 'ashlrai/phantom', arm: `cloud:${CLOUD_SEAT_ID}`, playbook: null, status: 'failed', updatedAt: '2026-10-25T23:00:00.000Z' },
    ]);
    expect(reviews).toEqual([
      {
        v: 1, id: 'cloud-review:ct_merged', jobId: 'ct_merged', repo: 'ashlrai/phantom',
        kind: 'review-block', updatedAt: '2026-10-25T23:00:00.000Z',
        body: `Recorded GitHub review verdict with 2 recorded change requests on ashlrai/phantom#42 at head ${'a'.repeat(12)}.`,
      },
    ]);
  });

  it('emits a review row when only the changes-requested count is recorded', () => {
    const { reviews } = foldCloudTasks([
      cloudTask({
        state: 'closed',
        outcome: { observedAt: '2026-10-25T23:00:00.000Z', headSha: null, mergeSha: null, ci: 'failure', failedChecks: ['test'], reviewDecision: null, changesRequested: 1 },
      }),
    ], NOW);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ id: 'cloud-review:ct_20261025T200000Z_abc123', jobId: 'ct_20261025T200000Z_abc123' });
  });

  it('skips tasks without provable attribution and drops future timestamps', () => {
    const { jobs, reviews } = foldCloudTasks([
      cloudTask({ id: 'bad id!', state: 'merged' }),
      cloudTask({ id: 'ct_bad_repo', repo: 'phantom', state: 'merged' }),
      cloudTask({ id: 'ct_future', state: 'merged', updatedAt: '2026-10-27T00:00:00.000Z' }),
      cloudTask({
        id: 'ct_future_review', state: 'closed',
        outcome: { observedAt: '2026-10-27T00:00:00.000Z', headSha: null, mergeSha: null, ci: null, failedChecks: [], reviewDecision: 'CHANGES_REQUESTED', changesRequested: 1 },
      }),
    ], NOW);
    // The closed task still emits its job; only the future-dated review row is dropped.
    expect(jobs).toEqual([
      { v: 1, id: 'ct_future_review', repo: 'ashlrai/phantom', arm: `cloud:${CLOUD_SEAT_ID}`, playbook: null, status: 'failed', updatedAt: '2026-10-25T23:00:00.000Z' },
    ]);
    expect(reviews).toEqual([]);
  });
});

describe('foldDevinTasks', () => {
  it('emits terminal tasks with devin-mode arms and skips chat sessions without a PR', () => {
    const jobs = foldDevinTasks([
      devinTask({ id: 'dv_merged', devinMode: 'fast' }),
      devinTask({ id: 'dv_closed', state: 'closed', devinMode: 'lite', updatedAt: '2026-10-25T22:00:00.000Z' }),
      devinTask({ id: 'dv_chat', origin: 'chat', pr: null, state: 'expired' }),
      devinTask({ id: 'dv_chat_pr', origin: 'chat', state: 'merged', pr: { number: 9, url: 'https://github.com/ashlrai/phantom/pull/9', state: 'merged', draft: false, title: 't' } }),
      devinTask({ id: 'dv_running', state: 'running' }),
      devinTask({ id: 'dv_superseded', state: 'closed', supersededBy: { repo: 'ashlrai/phantom', number: 8 } }),
    ], NOW);
    expect(jobs).toEqual([
      { v: 1, id: 'dv_chat_pr', repo: 'ashlrai/phantom', arm: 'devin:normal', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T23:00:00.000Z' },
      { v: 1, id: 'dv_closed', repo: 'ashlrai/phantom', arm: 'devin:lite', playbook: null, status: 'failed', updatedAt: '2026-10-25T22:00:00.000Z' },
      { v: 1, id: 'dv_merged', repo: 'ashlrai/phantom', arm: 'devin:fast', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T23:00:00.000Z' },
    ]);
  });
});

describe('ensureNightlyInputs', () => {
  it('writes contract jobs.jsonl from the fleet ledger and completes the nightly run', async () => {
    await writeLedger([
      fleetRow(),
      fleetRow({ job: 'RQ-TEST-2', state: 'FAILED', failed: true, ts: '2026-10-25T23:30:00.000Z' }),
    ]);
    // An empty review file is contract-valid; the review channel stays external.
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    await writeFile(inputPath('review-blocks.jsonl'), '', { mode: 0o600 });

    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    const jobs = await readJobsInput();
    expect(jobs.map((job) => [job.id, job.status])).toEqual([['RQ-TEST-1', 'succeeded'], ['RQ-TEST-2', 'failed']]);

    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
    const state = (await readNightlyState())!;
    expect(state.completedNight).toBe('2026-10-26');
    expect(state.jobs).toHaveLength(2);
    expect(state.priors).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: 'ashlrai/phantom', arm: 'work', successes: 1, failures: 1 }),
    ]));
  });

  it('does not write jobs.jsonl when the fleet ledger is missing', async () => {
    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    await expect(readFile(inputPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps externally supplied rows and lets the newer observation win', async () => {
    const external: NightlyJob = {
      v: 1, id: 'EXTERNAL-1', repo: 'ashlrai/phantom', arm: 'external-arm',
      playbook: null, status: 'succeeded', updatedAt: '2026-10-25T10:00:00.000Z',
    };
    const staleFleet = { v: 1, id: 'EXTERNAL-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'failed' as const, updatedAt: '2026-10-25T09:00:00.000Z' };
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    await writeFile(inputPath(), `${JSON.stringify(external)}\n${JSON.stringify(staleFleet)}\n`, { mode: 0o600 });
    await writeLedger([fleetRow({ job: 'EXTERNAL-1', state: 'FAILED', failed: true, ts: '2026-10-25T12:00:00.000Z' })]);

    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    const jobs = await readJobsInput();
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(byId.get('EXTERNAL-1')).toMatchObject({ status: 'failed', updatedAt: '2026-10-25T12:00:00.000Z', arm: 'work' });
  });

  it('leaves a corrupt jobs.jsonl untouched so the run still fails closed', async () => {
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    const corrupt = '{"v":1,"id":"BROKEN"\n';
    await writeFile(inputPath(), corrupt, { mode: 0o600 });
    await writeLedger([fleetRow()]);

    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    expect(await readFile(inputPath(), 'utf8')).toBe(corrupt);
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
  });

  it('writes an empty review-blocks.jsonl when no review evidence exists so the night completes', async () => {
    await writeLedger([fleetRow()]);
    await ensureNightlyInputs({ runsDir, nowMs: NOW, cloudTasks: () => [], devinTasks: () => [] });
    expect(await readReviewsInput()).toEqual([]);
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
  });

  it('merges cloud and devin task outcomes into jobs and review verdicts into review-blocks', async () => {
    await writeLedger([fleetRow()]);
    await ensureNightlyInputs({
      runsDir, nowMs: NOW,
      cloudTasks: () => [cloudTask({
        id: 'ct_reviewed', state: 'closed',
        outcome: {
          observedAt: '2026-10-25T23:30:00.000Z', headSha: null, mergeSha: null, ci: 'success',
          failedChecks: [], reviewDecision: 'CHANGES_REQUESTED', changesRequested: 1,
        },
      })],
      devinTasks: () => [devinTask({ id: 'dv_done', state: 'merged' })],
    });

    const jobs = await readJobsInput();
    expect(jobs.map((job) => [job.id, job.arm, job.status])).toEqual(expect.arrayContaining([
      ['RQ-TEST-1', 'work', 'succeeded'],
      ['ct_reviewed', `cloud:${CLOUD_SEAT_ID}`, 'failed'],
      ['dv_done', 'devin:normal', 'succeeded'],
    ]));
    const reviews = await readReviewsInput();
    expect(reviews).toEqual([
      expect.objectContaining({ id: 'cloud-review:ct_reviewed', jobId: 'ct_reviewed', repo: 'ashlrai/phantom', kind: 'review-block' }),
    ]);

    const result = await runNightlyRetro(ENABLED, NOW);
    expect(result.status).toBe('completed');
    const state = (await readNightlyState())!;
    // The review row joins its cloud job and becomes a 'review' lesson.
    expect(state.lessons).toEqual(expect.arrayContaining([
      expect.objectContaining({ cause: 'review', repo: 'ashlrai/phantom' }),
    ]));
    expect(state.reviews).toEqual([
      expect.objectContaining({ id: 'cloud-review:ct_reviewed', cause: 'review', jobId: 'ct_reviewed' }),
    ]);
  });

  it('keeps externally supplied review rows and never clobbers them', async () => {
    await writeLedger([fleetRow()]);
    const external: NightlyReviewInput = {
      v: 1, id: 'external-review-1', jobId: 'RQ-TEST-1', repo: 'ashlrai/phantom',
      kind: 'review-block', updatedAt: '2026-10-25T10:00:00.000Z', body: 'Reviewer asked for a smaller diff.',
    };
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    await writeFile(inputPath('review-blocks.jsonl'), `${JSON.stringify(external)}\n`, { mode: 0o600 });

    await ensureNightlyInputs({ runsDir, nowMs: NOW, cloudTasks: () => [], devinTasks: () => [] });
    const reviews = await readReviewsInput();
    expect(reviews).toEqual([expect.objectContaining({ id: 'external-review-1', body: external.body })]);
  });

  it('leaves a corrupt review-blocks.jsonl untouched so the run still fails closed', async () => {
    await writeLedger([fleetRow()]);
    const corrupt = '{"v":1,"id":"BROKEN"\n';
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    await writeFile(inputPath('review-blocks.jsonl'), corrupt, { mode: 0o600 });

    await ensureNightlyInputs({ runsDir, nowMs: NOW, cloudTasks: () => [], devinTasks: () => [] });
    expect(await readFile(inputPath('review-blocks.jsonl'), 'utf8')).toBe(corrupt);
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
  });

  it('suppresses task-derived rows and the review file when a task store cannot be read', async () => {
    await writeLedger([fleetRow()]);
    await ensureNightlyInputs({
      runsDir, nowMs: NOW,
      cloudTasks: () => { throw new Error('store unreadable'); },
      devinTasks: () => [],
    });
    // Fleet jobs still feed; the review file stays absent rather than asserting "none".
    expect((await readJobsInput()).map((job) => job.id)).toEqual(['RQ-TEST-1']);
    await expect(readFile(inputPath('review-blocks.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // Suppression is per feed attempt: the run's own feed reads the real
    // (empty) stores successfully and the night completes.
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
  });
});
