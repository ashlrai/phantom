import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyFeedbackSubmission,
  FEEDBACK_STALLED_GRACE_HOURS,
  FEEDBACK_SUBMISSIONS_WINDOW_HOURS,
  feedbackSubmissionCells,
  feedbackSubmissionsBacklogItems,
  type FeedbackSubmissionCell,
} from '../src/core/improve/feedback-submissions-backlog.js';
import type { FeedbackSubmission } from '../src/core/fleet/feedback-cycle.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the writers emit. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One feedback-queued journal row in recordFeedbackQueued's writer shape. */
function queuedRow(job: string, atMs: number, over: Record<string, unknown> = {}): string {
  return J({
    at: iso(atMs), job, source: 'github-issue',
    ref: `https://github.com/ashlrai/phantom/issues/${job.slice(-4)}`, kind: 'bug',
    ...over,
  });
}

// --- jobs-ledger row builders (dispatchd dialect) -------------------------

const launchRow = (job: string, atMs: number): string =>
  J({ event: 'launch', job, repo: 'phantom', lane: 'work', tier: 'mid', ts: iso(atMs) });
const finishRow = (job: string, atMs: number): string =>
  J({ event: 'finish', job, repo: 'phantom', wall_s: 42, ts: iso(atMs) });
const outcomeRow = (job: string, state: string, atMs: number): string =>
  J({ event: 'outcome', job, repo: 'phantom', state, ts: iso(atMs) });
const publishPrRow = (job: string, atMs: number, n: number): string =>
  J({ event: 'publish', job, repo: 'phantom', class: 'pr', url: `https://github.com/ashlrai/phantom/pull/${n}`, ts: iso(atMs) });
const launchFailedRow = (job: string, atMs: number): string =>
  J({ event: 'launch_failed', job, repo: 'phantom', action: 'give_up', ts: iso(atMs) });

/** A digest-shaped submission record for the pure cell fold. */
function submission(job: string, state: FeedbackSubmission['state'], atMs: number | null, over: Record<string, unknown> = {}): FeedbackSubmission {
  return {
    job, request: null, source: null, kind: null, state,
    pr: null, at: atMs === null ? null : iso(atMs), ...over,
  } as FeedbackSubmission;
}

const GRACE_MS = FEEDBACK_STALLED_GRACE_HOURS * HOUR;

describe('classifyFeedbackSubmission', () => {
  it('maps digest states to classes with the stall grace as the only absence guard', () => {
    expect(classifyFeedbackSubmission(submission('RQ-PHX-FB1', 'action-required', NOW_MS - DAY), NOW_MS, GRACE_MS)).toBe('action-required');
    // 'queued' aged past the grace is the only stalled shape.
    expect(classifyFeedbackSubmission(submission('RQ-PHX-FB2', 'queued', NOW_MS - GRACE_MS - 1), NOW_MS, GRACE_MS)).toBe('stalled');
    expect(classifyFeedbackSubmission(submission('RQ-PHX-FB3', 'queued', NOW_MS - GRACE_MS + 1), NOW_MS, GRACE_MS)).toBeNull();
    // Undated and in-flight states are context, never guesses.
    expect(classifyFeedbackSubmission(submission('RQ-PHX-FB4', 'queued', null), NOW_MS, GRACE_MS)).toBeNull();
    expect(classifyFeedbackSubmission(submission('RQ-PHX-FB5', 'under-review', NOW_MS - 10 * DAY), NOW_MS, GRACE_MS)).toBeNull();
    expect(classifyFeedbackSubmission(submission('RQ-PHX-FB6', 'merged', NOW_MS - DAY), NOW_MS, GRACE_MS)).toBeNull();
  });
});

describe('feedbackSubmissionCells', () => {
  it('emits recurring adverse classes only and quotes the window denominator', () => {
    const subs = [
      // action-required across three days
      submission('RQ-PHX-FB0001AA', 'action-required', NOW_MS - 4 * DAY),
      submission('RQ-PHX-FB0002BB', 'action-required', NOW_MS - 3 * DAY),
      submission('RQ-PHX-FB0003CC', 'action-required', NOW_MS - 2 * DAY),
      // stalled across two days (aged past grace, inside window)
      submission('RQ-PHX-FB0004DD', 'queued', NOW_MS - 5 * DAY),
      submission('RQ-PHX-FB0005EE', 'queued', NOW_MS - 4 * DAY),
      submission('RQ-PHX-FB0006FF', 'queued', NOW_MS - 6 * DAY),
      // context: young queued, under-review, merged, undated, out-of-window
      submission('RQ-PHX-FB0007GG', 'queued', NOW_MS - HOUR),
      submission('RQ-PHX-FB0008HH', 'under-review', NOW_MS - 2 * DAY),
      submission('RQ-PHX-FB0009JJ', 'merged', NOW_MS - DAY),
      submission('RQ-PHX-FB0010KK', 'queued', null),
      submission('RQ-PHX-FB0011LL', 'action-required', NOW_MS - 30 * DAY),
    ];
    const journal = new Map<string, { source: string | null; kind: string | null }>([
      ['RQ-PHX-FB0001AA', { source: 'github-issue', kind: 'bug' }],
      ['RQ-PHX-FB0002BB', { source: 'ci-failure', kind: 'regression' }],
      ['RQ-PHX-FB0003CC', { source: 'revert', kind: 'bug' }],
      ['RQ-PHX-FB0004DD', { source: 'pr-comment', kind: 'flake' }],
      ['RQ-PHX-FB0005EE', { source: null, kind: null }],
    ]);
    const { cells, window } = feedbackSubmissionCells(subs, journal, NOW_MS, FEEDBACK_SUBMISSIONS_WINDOW_HOURS, GRACE_MS, { jobsLowerBound: true });
    expect(cells.map((c) => c.cls)).toEqual(['action-required', 'stalled']);
    const [ar, stalled] = cells as [FeedbackSubmissionCell, FeedbackSubmissionCell];
    expect(ar.submissions).toBe(3);
    expect(ar.days).toEqual([new Date(NOW_MS - 4 * DAY).toISOString().slice(0, 10), new Date(NOW_MS - 3 * DAY).toISOString().slice(0, 10), new Date(NOW_MS - 2 * DAY).toISOString().slice(0, 10)]);
    expect(ar.examples).toEqual(['RQ-PHX-FB0001AA', 'RQ-PHX-FB0002BB', 'RQ-PHX-FB0003CC']);
    expect(ar.sources).toEqual([{ text: 'ci-failure', count: 1 }, { text: 'github-issue', count: 1 }, { text: 'revert', count: 1 }]);
    expect(ar.kinds).toEqual([{ text: 'bug', count: 2 }, { text: 'regression', count: 1 }]);
    expect(ar.jobsLowerBound).toBe(true);
    expect(stalled.submissions).toBe(3);
    expect(stalled.kinds).toEqual([{ text: 'unrecorded', count: 2 }, { text: 'flake', count: 1 }]);
    expect(window.total).toBe(9); // dated in-window submissions
    expect(window.undated).toBe(1);
    expect(window.queued).toBe(4); // 3 stalled + 1 young
    expect(window.stalled).toBe(3);
    expect(window.underReview).toBe(1);
    expect(window.merged).toBe(1);
    expect(window.actionRequired).toBe(3);
    expect(window.adverse.get('action-required')).toBe(3);
    expect(window.adverse.get('stalled')).toBe(3);
  });

  it('holds the recurring bars: count, distinct days and safe ids', () => {
    const subs = [
      submission('RQ-PHX-FB0001AA', 'action-required', NOW_MS - 2 * DAY - 4 * HOUR),
      submission('RQ-PHX-FB0002BB', 'action-required', NOW_MS - 2 * DAY - 2 * HOUR),
      submission('RQ-PHX-FB0003CC', 'action-required', NOW_MS - 2 * DAY),
    ];
    // Three submissions but all on one UTC day → below the days bar.
    const { cells } = feedbackSubmissionCells(subs, new Map(), NOW_MS, FEEDBACK_SUBMISSIONS_WINDOW_HOURS, GRACE_MS);
    expect(cells).toEqual([]);
    // Two submissions across two days → below the count bar.
    const fewer = subs.slice(0, 2).map((s, i) => submission(`RQ-PHX-FB000${i}DD`, 'action-required', NOW_MS - (i + 2) * DAY));
    expect(feedbackSubmissionCells(fewer, new Map(), NOW_MS, FEEDBACK_SUBMISSIONS_WINDOW_HOURS, GRACE_MS).cells).toEqual([]);
  });
});

describe('feedbackSubmissionsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'feedback-submissions-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose feedback/ and metrics/ carry the given journal and jobs rows. */
  async function runsDir(name: string, queued: string[] | null, jobs: string[] | null): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (queued !== null) {
      await mkdir(join(dir, 'feedback'), { recursive: true });
      await writeFile(join(dir, 'feedback', 'feedback-queued.jsonl'), queued.length ? queued.join('\n') + '\n' : '');
    }
    if (jobs !== null) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.length ? jobs.join('\n') + '\n' : '');
    return dir;
  }

  /** Three action-required submissions across three days — journal admission plus a bare finish. */
  const failedFixture = () => ({
    queued: [
      queuedRow('RQ-PHX-FB0A1B2C3', NOW_MS - 5 * DAY),
      queuedRow('RQ-PHX-FB0D4E5F6', NOW_MS - 4 * DAY, { source: 'ci-failure', kind: 'regression' }),
      queuedRow('RQ-PHX-FB0G7H8J9', NOW_MS - 3 * DAY, { source: 'self-report', kind: 'flake' }),
    ],
    jobs: [
      launchRow('RQ-PHX-FB0A1B2C3', NOW_MS - 5 * DAY), finishRow('RQ-PHX-FB0A1B2C3', NOW_MS - 4 * DAY),
      launchRow('RQ-PHX-FB0D4E5F6', NOW_MS - 4 * DAY), outcomeRow('RQ-PHX-FB0D4E5F6', 'CLOSED', NOW_MS - 3 * DAY),
      launchFailedRow('RQ-PHX-FB0G7H8J9', NOW_MS - 3 * DAY),
      launchRow('RQ-FLEET-OK', NOW_MS - 6 * DAY),
    ],
  });

  /** Three stalled submissions: admitted 4–6 days ago, no jobs-ledger rows at all. */
  const stalledFixture = () => ({
    queued: [
      queuedRow('RQ-PHX-FB1A2B3C4', NOW_MS - 4 * DAY),
      queuedRow('RQ-PHX-FB1D5E6F7', NOW_MS - 5 * DAY, { source: 'comms', kind: 'feature' }),
      queuedRow('RQ-PHX-FB1G8H9J0', NOW_MS - 6 * DAY),
    ],
    jobs: [launchRow('RQ-FLEET-OK', NOW_MS - DAY)],
  });

  it('emits an action-required item for recurring failed community jobs', async () => {
    const f = failedFixture();
    const dir = await runsDir('runs-failed', f.queued, f.jobs);
    const items = await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'feedback-submissions' });
    expect(item!.id).toMatch(/^feedback-submissions-action-required-[0-9a-f]{16}$/);
    expect(item!.title).toContain('action-required');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-PHX-FB0A1B2C3');
    expect(item!.prompt).toContain('feedback-queued.jsonl');
    expect(item!.prompt).toContain('feedbackDigest');
    expect(item!.prompt).toContain('3 submission(s)');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits a stalled item for admissions unresolved past the grace', async () => {
    const f = stalledFixture();
    const dir = await runsDir('runs-stalled', f.queued, f.jobs);
    const items = await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.id).toMatch(/^feedback-submissions-stalled-[0-9a-f]{16}$/);
    expect(item!.title).toContain('stalling unresolved');
    expect(item!.prompt).toContain('RQ-PHX-FB1A2B3C4');
    expect(item!.prompt).toContain('queue-latency grace');
    expect(validBacklogItem(item)).not.toBeNull();
  });

  it('emits both classes when both recur, capped and stably identified', async () => {
    const f = failedFixture();
    const dir = await runsDir('runs-both', [...f.queued, ...stalledFixture().queued], [...f.jobs, ...stalledFixture().jobs]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await feedbackSubmissionsBacklogItems(opts);
    const second = await feedbackSubmissionsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const limited = await feedbackSubmissionsBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('emits nothing for missing evidence, a withheld jobs ledger, another repository, or below-bar cells', async () => {
    // No runs dir at all.
    expect(await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const f = failedFixture();
    // Journal present but no jobs.jsonl — the outcome fold cannot run.
    const noJobs = await runsDir('runs-nojobs', f.queued, null);
    expect(await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: noJobs, now: NOW })).toEqual([]);

    // Injected withheld ledger — same honesty through the test seam.
    const dir = await runsDir('runs-thin', f.queued, f.jobs);
    expect(await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, jobsText: null, now: NOW })).toEqual([]);

    // Empty ledger leaves every submission queued-young or stalled-by-age only;
    // the failed fixture's jobs carry the adverse evidence, so an empty
    // ledger still yields the stalled class for the aged admissions —
    // but never the action-required one.
    const emptyLedger = await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, jobsText: '', now: NOW });
    expect(emptyLedger.every((i) => i.id.startsWith('feedback-submissions-stalled-'))).toBe(true);

    // Below the bars and the repo gate.
    const twoFailed = { queued: f.queued.slice(0, 2), jobs: f.jobs.filter((r) => !r.includes('RQ-PHX-FB0G7H8J9')) };
    const thin = await runsDir('runs-thin2', twoFailed.queued, twoFailed.jobs);
    expect(await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
    const recurring = await runsDir('runs-rec', f.queued, f.jobs);
    expect(await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/lexicon', runsDir: recurring, now: NOW })).toEqual([]);
    expect(await feedbackSubmissionsBacklogItems({ repo: '', runsDir: recurring, now: NOW })).toEqual([]);
  });

  it('treats merged, under-review and young queued submissions as context', async () => {
    const healthy = {
      queued: [
        queuedRow('RQ-PHX-FB2A2B3C4', NOW_MS - 4 * DAY),
        queuedRow('RQ-PHX-FB2D5E6F7', NOW_MS - 3 * DAY),
        queuedRow('RQ-PHX-FB2G8H9J0', NOW_MS - 2 * DAY),
        queuedRow('RQ-PHX-FB2K1L2M3', NOW_MS - HOUR),
      ],
      jobs: [
        launchRow('RQ-PHX-FB2A2B3C4', NOW_MS - 4 * DAY), outcomeRow('RQ-PHX-FB2A2B3C4', 'MERGED', NOW_MS - 3 * DAY),
        launchRow('RQ-PHX-FB2D5E6F7', NOW_MS - 3 * DAY), publishPrRow('RQ-PHX-FB2D5E6F7', NOW_MS - 2 * DAY, 11),
        launchRow('RQ-PHX-FB2G8H9J0', NOW_MS - DAY), // launched, still in flight
        // RQ-PHX-FB2K1L2M3: journal-only, admitted an hour ago — inside latency.
        launchRow('RQ-FLEET-OK', NOW_MS - 5 * DAY),
      ],
    };
    const dir = await runsDir('runs-healthy', healthy.queued, healthy.jobs);
    expect(await feedbackSubmissionsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW })).toEqual([]);
  });

  it('appends feedback-submission items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'feedback'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number): number => realNow - d * DAY;
    await writeFile(join(runs, 'feedback', 'feedback-queued.jsonl'), [
      queuedRow('RQ-PHX-FB3A3B3C3', at(5)),
      queuedRow('RQ-PHX-FB3D3E3F3', at(4), { source: 'revert', kind: 'regression' }),
      queuedRow('RQ-PHX-FB3G3H3J3', at(3)),
    ].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      launchRow('RQ-PHX-FB3A3B3C3', at(5)), finishRow('RQ-PHX-FB3A3B3C3', at(4)),
      launchRow('RQ-PHX-FB3D3E3F3', at(4)), outcomeRow('RQ-PHX-FB3D3E3F3', 'CLOSED', at(3)),
      launchFailedRow('RQ-PHX-FB3G3H3J3', at(3)),
      launchRow('RQ-FLEET-OK', at(6)),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const fbItems = first.items.filter((i) => i.id.startsWith('feedback-submissions-'));
    expect(fbItems).toHaveLength(1);
    expect(fbItems[0]!.area).toBe('feedback-submissions');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(fbItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('feedback-submissions-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('feedback-submissions-'))).toHaveLength(1);
  });
});
