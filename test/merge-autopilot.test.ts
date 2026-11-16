/**
 * Merge autopilot (`phm land auto`, src/core/fleet/merge-autopilot.ts) —
 * RQ-MERGEAUTOPILOTQ7 acceptance: table tests per class (green-ready,
 * BEHIND, CONFLICTING, red-required), the 3-actions/24 h cap, the repo hold
 * list, the --apply env gate, and GitHub-error fail-closed.
 *
 * Hermetic: records live in the suite's isolated HOME store (the real
 * read/list path), GitHub is a route-table transport, the queue is a spy,
 * and `armed`/`nowMs`/`listHolds` are injected — no network, no real env.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  classifyMergeAutopilotPr,
  firstFailingRequiredCheck,
  runMergeAutopilot,
  type MergeAutopilotDeps,
} from '../src/core/fleet/merge-autopilot.js';
import {
  newFleetMergeState,
  proposalStateKey,
  readFleetMergeState,
  writeFleetMergeState,
  type FleetMergeStateV1,
} from '../src/core/fleet/fleet-merge-state.js';
import {
  FLEET_APP_BOT_LOGIN,
  type GithubCall,
  type GithubReply,
  type HostMergeDeps,
} from '../src/core/fleet/host-merge.js';
import type {
  FleetTaskInput,
  RepoHold,
} from '../src/core/fleet/fleet-types.js';

const NOW = Date.parse('2026-02-10T12:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const sha = (ch: string) => ch.repeat(40);
const HEAD = sha('a');
const BASE_RECORDED = sha('b');
const BASE_LIVE = sha('c');
const MOVED_HEAD = sha('d');

let counter = 0;

/** A distinct repo per test so records written to the shared isolated store never bleed between cases. */
function nextRepo(): string {
  counter += 1;
  return `acme/widgets-${counter}`;
}

function mkRecord(repo: string, number: number, overrides: Partial<NonNullable<FleetMergeStateV1['pr']>> = {}): FleetMergeStateV1 {
  const key = proposalStateKey(`autopilot-test-${repo.split('/')[1]}`)!;
  const record = newFleetMergeState({
    key,
    kind: 'change',
    proposalId: key,
    revertsLandingId: null,
    repo,
    repoPath: `/tmp/${repo}`,
    enforcement: 'server',
    nowIso: NOW_ISO,
  });
  record.pr = {
    number,
    nodeId: `PR_${number}`,
    repositoryId: 'R_1',
    branch: `ashlr/fleet/test-${number}`,
    baseBranch: 'main',
    baseSha: BASE_RECORDED,
    headSha: HEAD,
    treeSha: sha('e'),
    ownerLane: false,
    ownerLaneReason: null,
    openedAt: NOW_ISO,
    ledgered: true,
    state: 'open',
    closedBy: null,
    nextCheckAt: null,
    checkBackoffMs: 0,
    checks: null,
    wouldMergeHeadSha: null,
    verifyCheck: null,
    ...overrides,
  };
  expect(writeFleetMergeState(record)).toBe(true);
  return record;
}

function prBody(repo: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    node_id: 'PR_12',
    state: 'open',
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: { sha: HEAD, ref: 'ashlr/fleet/test-12', repo: { full_name: repo } },
    base: { ref: 'main' },
    user: { login: FLEET_APP_BOT_LOGIN },
    labels: [],
    ...over,
  };
}

interface Route { status: number; body?: unknown }

/**
 * A route-table GitHub transport. Unrouted calls answer 404 so a test always
 * sees an explicit failure, and `calls` records every request (the
 * no-forbidden-effects assertions read it).
 */
function fakeHost(repo: string, routes: Record<string, Route | undefined>): { host: HostMergeDeps; calls: GithubCall[] } {
  const calls: GithubCall[] = [];
  const host: HostMergeDeps = {
    transport: async (call) => {
      calls.push(call);
      const hit = routes[`${call.method} ${call.path.replace(`/repos/${repo}`, '')}`];
      return { status: hit?.status ?? 404, body: hit?.body ?? { message: 'unrouted' } } satisfies GithubReply;
    },
    token: async () => ({ token: 'test-token', expiresAt: null }),
    nowMs: () => NOW,
    sleep: async () => {},
    killActive: () => false,
    killEpoch: () => 'x'.repeat(64),
    policy: () => null,
    appendLedger: (() => ({ ok: true as const })) as unknown as HostMergeDeps['appendLedger'],
    ledgerHead: () => null,
  };
  return { host, calls };
}

/** The routes a green, current, server-enforced PR takes. */
function greenRoutes(repo: string, over: Record<string, Route | undefined> = {}): Record<string, Route | undefined> {
  return {
    'GET /pulls/12': { status: 200, body: prBody(repo) },
    'GET /git/ref/heads/main': { status: 200, body: { object: { sha: BASE_RECORDED, type: 'commit' } } },
    'GET /rules/branches/main?per_page=100': {
      status: 200,
      body: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }],
    },
    'GET /branches/main': { status: 200, body: { name: 'main', protection: { enabled: false } } },
    [`GET /commits/${HEAD}/check-runs?per_page=100&page=1`]: {
      status: 200,
      body: { check_runs: [{ id: 1, name: 'ci', app: { id: 4242 }, status: 'completed', conclusion: 'success' }], total_count: 1 },
    },
    [`GET /commits/${HEAD}/status?per_page=100`]: { status: 200, body: { statuses: [] } },
    ...over,
  };
}

function deps(host: HostMergeDeps, over: Partial<MergeAutopilotDeps> = {}): MergeAutopilotDeps {
  return {
    host,
    listHolds: () => [],
    enqueue: vi.fn((input: FleetTaskInput) => ({
      ok: true as const,
      deduped: false,
      task: {
        v: 1 as const, id: 'task-1', repo: input.repo, source: input.source, title: input.title,
        detail: input.detail, difficulty: input.difficulty, value: input.value,
        requestedBy: input.requestedBy, goalId: null, landingId: null, insightId: null,
        dedupeKey: input.dedupeKey ?? null, status: 'queued' as const,
        sizeBudget: { files: 10, lines: 200 }, attempts: 0, parkedUntil: null,
        createdAt: NOW_ISO, updatedAt: NOW_ISO,
      },
    })),
    armed: () => true,
    nowMs: () => NOW,
    ...over,
  };
}

const hold = (repo: string): RepoHold => ({
  v: 1, repo, kind: 'owner-hold', reason: 'owner paused the repo', since: NOW_ISO, until: null, setBy: 'mason', landingId: null,
});

// ---------------------------------------------------------------------------
// Pure classification (no GitHub, no store)
// ---------------------------------------------------------------------------

describe('classifyMergeAutopilotPr', () => {
  const cases: { name: string; input: Parameters<typeof classifyMergeAutopilotPr>[0]; want: string }[] = [
    { name: 'green-ready', input: { mergeable: true, mergeableState: 'clean', baseMoved: false, checks: { state: 'green', code: 'ok' } }, want: 'green-ready' },
    { name: 'BEHIND (mergeable_state)', input: { mergeable: true, mergeableState: 'behind', baseMoved: false, checks: { state: 'green', code: 'ok' } }, want: 'behind' },
    { name: 'BEHIND (base head drifted)', input: { mergeable: true, mergeableState: 'clean', baseMoved: true, checks: { state: 'green', code: 'ok' } }, want: 'behind' },
    { name: 'CONFLICTING (dirty)', input: { mergeable: null, mergeableState: 'dirty', baseMoved: false, checks: { state: 'green', code: 'ok' } }, want: 'conflicting' },
    { name: 'CONFLICTING (mergeable false)', input: { mergeable: false, mergeableState: 'unstable', baseMoved: false, checks: { state: 'red', code: 'required-check-failed' } }, want: 'conflicting' },
    { name: 'red-required', input: { mergeable: true, mergeableState: 'unstable', baseMoved: false, checks: { state: 'red', code: 'required-check-failed' } }, want: 'red-required' },
    { name: 'pending', input: { mergeable: true, mergeableState: 'unstable', baseMoved: false, checks: { state: 'pending', code: 'checks-pending' } }, want: 'pending' },
    { name: 'unreadable checks fail closed', input: { mergeable: true, mergeableState: 'clean', baseMoved: false, checks: 'unreadable' }, want: 'unknown' },
    { name: 'a checks timeout is blocked, not red-required', input: { mergeable: true, mergeableState: 'unstable', baseMoved: false, checks: { state: 'red', code: 'checks-timeout' } }, want: 'blocked' },
    { name: 'owner-lane G7 outcome is held', input: { mergeable: true, mergeableState: 'clean', baseMoved: false, checks: { state: 'none', code: 'no-required-checks' } }, want: 'held' },
    { name: 'conflicting wins over behind', input: { mergeable: false, mergeableState: 'dirty', baseMoved: true, checks: 'unreadable' }, want: 'conflicting' },
    { name: 'green checks but GitHub still blocked', input: { mergeable: null, mergeableState: 'blocked', baseMoved: false, checks: { state: 'green', code: 'ok' } }, want: 'blocked' },
  ];
  for (const { name, input, want } of cases) {
    it(name, () => expect(classifyMergeAutopilotPr(input)).toBe(want));
  }
});

describe('firstFailingRequiredCheck', () => {
  it('names the first required context whose latest run is red', () => {
    const required = [{ context: 'build', appId: null }, { context: 'lint', appId: null }];
    const runs = [
      { id: 2, name: 'lint', appId: null, status: 'completed', conclusion: 'failure' },
      { id: 1, name: 'build', appId: null, status: 'completed', conclusion: 'success' },
    ];
    expect(firstFailingRequiredCheck('server', required, runs, [])).toBe('lint');
  });
  it('a superseded green run does not clear an older red one (latest wins)', () => {
    const required = [{ context: 'ci', appId: null }];
    const runs = [
      { id: 1, name: 'ci', appId: null, status: 'completed', conclusion: 'failure' },
      { id: 9, name: 'ci', appId: null, status: 'completed', conclusion: 'success' },
    ];
    expect(firstFailingRequiredCheck('server', required, runs, [])).toBeNull();
  });
  it('local enforcement: first red observation anywhere wins', () => {
    const runs = [{ id: 1, name: 'unit', appId: '9', status: 'completed', conclusion: 'failure' }];
    expect(firstFailingRequiredCheck('local', [], runs, [])).toBe('unit');
  });
});

// ---------------------------------------------------------------------------
// The pass — classification table, actions, cap, holds, fail-closed
// ---------------------------------------------------------------------------

describe('runMergeAutopilot classification', () => {
  const table: {
    name: string;
    routes: (repo: string) => Record<string, Route | undefined>;
    record?: Partial<FleetMergeStateV1['pr'] & object>;
    wantClass: string;
    wantActionKind: string | null;
  }[] = [
    {
      name: 'green-ready',
      routes: (repo) => greenRoutes(repo),
      wantClass: 'green-ready',
      wantActionKind: null,
    },
    {
      name: 'BEHIND (mergeable_state behind)',
      routes: (repo) => greenRoutes(repo, { 'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable_state: 'behind' }) } }),
      wantClass: 'behind',
      wantActionKind: 'update-branch',
    },
    {
      name: 'BEHIND (base moved since the recorded base)',
      routes: (repo) => greenRoutes(repo, { 'GET /git/ref/heads/main': { status: 200, body: { object: { sha: BASE_LIVE, type: 'commit' } } } }),
      wantClass: 'behind',
      wantActionKind: 'update-branch',
    },
    {
      name: 'CONFLICTING',
      routes: (repo) => ({ 'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable: false, mergeable_state: 'dirty' }) } }),
      wantClass: 'conflicting',
      wantActionKind: 'drain-task',
    },
    {
      name: 'red-required',
      routes: (repo) => greenRoutes(repo, {
        [`GET /commits/${HEAD}/check-runs?per_page=100&page=1`]: {
          status: 200,
          body: { check_runs: [{ id: 1, name: 'ci', app: { id: 4242 }, status: 'completed', conclusion: 'failure' }], total_count: 1 },
        },
      }),
      wantClass: 'red-required',
      wantActionKind: 'fixup-task',
    },
    {
      name: 'pending required check waits',
      routes: (repo) => greenRoutes(repo, {
        [`GET /commits/${HEAD}/check-runs?per_page=100&page=1`]: {
          status: 200,
          body: { check_runs: [{ id: 1, name: 'ci', app: { id: 4242 }, status: 'in_progress', conclusion: null }], total_count: 1 },
        },
      }),
      wantClass: 'pending',
      wantActionKind: null,
    },
    {
      name: 'merged PR is closed',
      routes: (repo) => ({ 'GET /pulls/12': { status: 200, body: prBody(repo, { merged: true }) } }),
      wantClass: 'closed',
      wantActionKind: null,
    },
    {
      name: 'head moved outside the fleet',
      routes: (repo) => greenRoutes(repo, { 'GET /pulls/12': { status: 200, body: prBody(repo, { head: { sha: MOVED_HEAD, ref: 'ashlr/fleet/test-12', repo: { full_name: repo } } }) } }),
      wantClass: 'moved',
      wantActionKind: null,
    },
    {
      name: 'owner-lane record is held without a GitHub read',
      routes: () => ({}),
      record: { ownerLane: true, ownerLaneReason: 'protected files' },
      wantClass: 'held',
      wantActionKind: null,
    },
    {
      name: 'unledgered PR is held',
      routes: () => ({}),
      record: { ledgered: false },
      wantClass: 'held',
      wantActionKind: null,
    },
    {
      name: 'GitHub read failure is unknown (fail closed)',
      routes: () => ({ 'GET /pulls/12': { status: 500, body: { message: 'boom' } } }),
      wantClass: 'unknown',
      wantActionKind: null,
    },
  ];

  for (const { name, routes, record, wantClass, wantActionKind } of table) {
    it(name, async () => {
      const repo = nextRepo();
      mkRecord(repo, 12, record ?? {});
      const { host, calls } = fakeHost(repo, routes(repo));
      const result = await runMergeAutopilot({ repo, deps: deps(host) });
      expect(result.ok).toBe(true);
      expect(result.prs).toHaveLength(1);
      expect(result.prs[0]!.class).toBe(wantClass);
      expect(result.prs[0]!.action?.kind ?? null).toBe(wantActionKind);
      expect(result.prs[0]!.action?.status ?? null).toBe(wantActionKind === null ? null : 'planned');
      // Dry-run: the only GitHub calls ever made are reads.
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    });
  }
});

describe('runMergeAutopilot --apply', () => {
  it('BEHIND issues the merge-method update-branch call and records the act', async () => {
    const repo = nextRepo();
    const record = mkRecord(repo, 12);
    const { host, calls } = fakeHost(repo, greenRoutes(repo, {
      'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable_state: 'behind' }) },
      'PUT /pulls/12/update-branch': { status: 202, body: { message: 'Updating pull request branch.' } },
    }));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host) });
    expect(result.ok).toBe(true);
    const action = result.prs[0]!.action;
    expect(action?.kind).toBe('update-branch');
    expect(action?.status).toBe('applied');
    const put = calls.filter((c) => c.method !== 'GET');
    expect(put).toHaveLength(1);
    // The ONLY GitHub effect: PUT update-branch pinned to the classified head. No rebase, no force, no admin.
    expect(put[0]!.method).toBe('PUT');
    expect(put[0]!.path).toBe(`/repos/${repo}/pulls/12/update-branch`);
    expect(put[0]!.body).toEqual({ expected_head_sha: HEAD });
    const memo = readFleetMergeState(record.key);
    expect(memo.state).toBe('ok');
    if (memo.state !== 'ok') return;
    expect(memo.record.autopilot?.actions).toHaveLength(1);
    expect(memo.record.autopilot?.actions[0]!.kind).toBe('update-branch');
  });

  it('refuses the update when the head drifted between classify and call', async () => {
    const repo = nextRepo();
    mkRecord(repo, 12);
    let updates = 0;
    let prReads = 0;
    const { host, calls } = fakeHost(repo, greenRoutes(repo));
    // The classify read sees the recorded head; updateFleetPrBranch's own
    // re-read sees a pushed head, so the pinned update is never dispatched.
    host.transport = async (call) => {
      calls.push(call);
      if (call.method === 'GET' && call.path === `/repos/${repo}/pulls/12`) {
        prReads += 1;
        const headSha = prReads === 1 ? HEAD : MOVED_HEAD;
        return { status: 200, body: prBody(repo, { mergeable_state: 'behind', head: { sha: headSha, ref: 'ashlr/fleet/test-12', repo: { full_name: repo } } }) };
      }
      if (call.method === 'GET' && call.path === `/repos/${repo}/git/ref/heads/main`) {
        return { status: 200, body: { object: { sha: BASE_RECORDED, type: 'commit' } } };
      }
      if (call.method === 'PUT' && call.path === `/repos/${repo}/pulls/12/update-branch`) {
        updates += 1;
        return { status: 202, body: {} };
      }
      return { status: 404, body: { message: 'unrouted' } };
    };
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host) });
    expect(result.ok).toBe(true);
    expect(result.prs[0]!.class).toBe('behind');
    expect(result.prs[0]!.action?.status).toBe('failed');
    expect(updates).toBe(0);
  });

  it('CONFLICTING enqueues a DRAIN task; red-required enqueues a FIXUP naming the first failing check', async () => {
    const conflictRepo = nextRepo();
    mkRecord(conflictRepo, 12);
    const conflictHost = fakeHost(conflictRepo, {
      'GET /pulls/12': { status: 200, body: prBody(conflictRepo, { mergeable: false, mergeable_state: 'dirty' }) },
    });
    const enqueue = vi.fn((input: FleetTaskInput) => ({
      ok: true as const, deduped: false,
      task: {
        v: 1 as const, id: 't-1', repo: input.repo, source: input.source, title: input.title, detail: input.detail,
        difficulty: input.difficulty, value: input.value, requestedBy: input.requestedBy,
        goalId: null, landingId: null, insightId: null, dedupeKey: input.dedupeKey ?? null,
        status: 'queued' as const, sizeBudget: { files: 10, lines: 200 }, attempts: 0, parkedUntil: null,
        createdAt: NOW_ISO, updatedAt: NOW_ISO,
      },
    }));
    const drain = await runMergeAutopilot({ repo: conflictRepo, apply: true, deps: deps(conflictHost.host, { enqueue }) });
    expect(drain.prs[0]!.class).toBe('conflicting');
    expect(drain.prs[0]!.action).toMatchObject({ kind: 'drain-task', status: 'applied' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0].title).toContain('resolve merge conflicts');
    expect(enqueue.mock.calls[0]![0].detail).toContain('Do not force-push');

    const redRepo = nextRepo();
    mkRecord(redRepo, 12);
    const redHost = fakeHost(redRepo, greenRoutes(redRepo, {
      [`GET /commits/${HEAD}/check-runs?per_page=100&page=1`]: {
        status: 200,
        body: {
          check_runs: [
            { id: 3, name: 'ci', app: { id: 4242 }, status: 'completed', conclusion: 'failure' },
            { id: 4, name: 'lint', app: { id: 7 }, status: 'completed', conclusion: 'failure' },
          ],
          total_count: 2,
        },
      },
      'GET /rules/branches/main?per_page=100': {
        status: 200,
        body: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }, { context: 'lint' }] } }],
      },
    }));
    enqueue.mockClear();
    const fixup = await runMergeAutopilot({ repo: redRepo, apply: true, deps: deps(redHost.host, { enqueue }) });
    expect(fixup.prs[0]!.class).toBe('red-required');
    expect(fixup.prs[0]!.firstFailingCheck).toBe('ci');
    expect(fixup.prs[0]!.action).toMatchObject({ kind: 'fixup-task', status: 'applied' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0].title).toContain('ci');
    expect(enqueue.mock.calls[0]![0].detail).toContain('ci');
  });

  it('per-PR cap: a 4th action inside 24 h is skipped and nothing is touched', async () => {
    const repo = nextRepo();
    const record = mkRecord(repo, 12);
    record.autopilot = {
      actions: [
        { kind: 'update-branch', at: new Date(NOW - 1_000).toISOString(), detail: null },
        { kind: 'drain-task', at: new Date(NOW - 60_000).toISOString(), detail: null },
        { kind: 'fixup-task', at: new Date(NOW - 120_000).toISOString(), detail: null },
      ],
    };
    expect(writeFleetMergeState(record)).toBe(true);
    const { host, calls } = fakeHost(repo, greenRoutes(repo, {
      'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable_state: 'behind' }) },
      'PUT /pulls/12/update-branch': { status: 202, body: {} },
    }));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host) });
    expect(result.prs[0]!.class).toBe('behind');
    expect(result.prs[0]!.action?.status).toBe('skipped');
    expect(result.prs[0]!.action?.detail).toContain('cap');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const memo = readFleetMergeState(record.key);
    expect(memo.state === 'ok' && memo.record.autopilot?.actions.length === 3).toBe(true);
  });

  it('actions older than 24 h do not count toward the cap', async () => {
    const repo = nextRepo();
    const record = mkRecord(repo, 12);
    record.autopilot = {
      actions: [
        { kind: 'update-branch', at: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(), detail: null },
        { kind: 'update-branch', at: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(), detail: null },
        { kind: 'update-branch', at: new Date(NOW - 30 * 60 * 60 * 1000).toISOString(), detail: null },
      ],
    };
    expect(writeFleetMergeState(record)).toBe(true);
    const { host, calls } = fakeHost(repo, greenRoutes(repo, {
      'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable_state: 'behind' }) },
      'PUT /pulls/12/update-branch': { status: 202, body: {} },
    }));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host) });
    expect(result.prs[0]!.action?.status).toBe('applied');
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('a repo hold holds the PR without touching GitHub', async () => {
    const repo = nextRepo();
    mkRecord(repo, 12);
    const { host, calls } = fakeHost(repo, greenRoutes(repo));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host, { listHolds: () => [hold(repo)] }) });
    expect(result.ok).toBe(true);
    expect(result.prs[0]!.class).toBe('held');
    expect(result.prs[0]!.detail).toContain('owner-hold');
    expect(result.prs[0]!.action).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('an unreadable hold list fails the whole run closed', async () => {
    const repo = nextRepo();
    mkRecord(repo, 12);
    const { host, calls } = fakeHost(repo, greenRoutes(repo));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host, { listHolds: () => { throw new Error('holds store corrupt'); } }) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('hold list');
    expect(calls).toHaveLength(0);
  });

  it('a hold on a DIFFERENT repo does not hold this one', async () => {
    const repo = nextRepo();
    mkRecord(repo, 12);
    const { host } = fakeHost(repo, greenRoutes(repo));
    const result = await runMergeAutopilot({ repo, deps: deps(host, { listHolds: () => [hold('other/repo')] }) });
    expect(result.prs[0]!.class).toBe('green-ready');
  });

  it('--apply without PHANTOM_MERGE_AUTOPILOT=1 refuses the run', async () => {
    const repo = nextRepo();
    mkRecord(repo, 12);
    const { host, calls } = fakeHost(repo, greenRoutes(repo));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host, { armed: () => false }) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('PHANTOM_MERGE_AUTOPILOT=1');
    expect(calls).toHaveLength(0);
  });

  it('a GitHub error under --apply never acts and records nothing', async () => {
    const repo = nextRepo();
    const record = mkRecord(repo, 12);
    const enqueue = vi.fn();
    const { host } = fakeHost(repo, {
      'GET /pulls/12': { status: 502, body: { message: 'bad gateway' } },
    });
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host, { enqueue }) });
    expect(result.ok).toBe(true);
    expect(result.prs[0]!.class).toBe('unknown');
    expect(result.prs[0]!.action).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    const memo = readFleetMergeState(record.key);
    expect(memo.state === 'ok' && (memo.record.autopilot?.actions.length ?? 0) === 0).toBe(true);
  });

  it('an update-branch refusal is reported, not queued or remembered', async () => {
    const repo = nextRepo();
    const record = mkRecord(repo, 12);
    const { host } = fakeHost(repo, greenRoutes(repo, {
      'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable_state: 'behind' }) },
      'PUT /pulls/12/update-branch': { status: 422, body: { message: 'merge conflict' } },
    }));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host) });
    expect(result.prs[0]!.action?.status).toBe('failed');
    const memo = readFleetMergeState(record.key);
    expect(memo.state === 'ok' && (memo.record.autopilot?.actions.length ?? 0) === 0).toBe(true);
  });

  it('a second apply run dedupes on the queued task, not the cap', async () => {
    const repo = nextRepo();
    mkRecord(repo, 12);
    const { host } = fakeHost(repo, {
      'GET /pulls/12': { status: 200, body: prBody(repo, { mergeable: false, mergeable_state: 'dirty' }) },
    });
    const enqueue = vi.fn((input: FleetTaskInput) => ({
      ok: true as const, deduped: true,
      task: {
        v: 1 as const, id: 't-9', repo: input.repo, source: input.source, title: input.title, detail: input.detail,
        difficulty: input.difficulty, value: input.value, requestedBy: input.requestedBy,
        goalId: null, landingId: null, insightId: null, dedupeKey: input.dedupeKey ?? null,
        status: 'queued' as const, sizeBudget: { files: 10, lines: 200 }, attempts: 0, parkedUntil: null,
        createdAt: NOW_ISO, updatedAt: NOW_ISO,
      },
    }));
    const result = await runMergeAutopilot({ repo, apply: true, deps: deps(host, { enqueue }) });
    expect(result.prs[0]!.action?.status).toBe('duplicate');
  });
});
