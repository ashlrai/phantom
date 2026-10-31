/**
 * RQ-V4-FLEET-MERGE-STATE-1: the fleet PR merge class — every fleet PR is
 * green-ready, behind, conflicted or red-required, derived from structured
 * `gh pr view --json` state (never PR text) so the router generates REFIX and
 * DRAIN work from state.
 *
 *   - green-ready  → drain  (land it)
 *   - behind       → drain  (re-verify on the moved base, then land)
 *   - conflicted   → refix  (the produced change must be redone)
 *   - red-required → refix  (a gating check failed on the head)
 *   - pending / closed / unknown → no work (wait / terminal / fail closed)
 */
import { describe, expect, it } from 'vitest';

import {
  classifyFleetMergeStatePr,
  classifyFleetPrGh,
  FLEET_PR_CLASS_WORK,
  newFleetMergeState,
  parseFleetPrGhState,
  rollupFleetPrChecks,
  type FleetMergeStateV1,
  type FleetPrClass,
  type FleetPrGhState,
  type FleetPrMemo,
} from '../src/core/fleet/fleet-merge-state.js';
import type { RepoEnforcement } from '../src/core/fleet/fleet-types.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const BRANCH = 'ashlr/fleet/prop-abc123';
const REPO = 'ashlrai/phantom';

/** A check run entry as `gh pr view --json statusCheckRollup` reports it. */
function checkRun(name: string, status: string, conclusion: string | null) {
  return { __typename: 'CheckRun', name, status, conclusion, workflowName: 'ci' };
}

function statusContext(context: string, state: string) {
  return { __typename: 'StatusContext', context, state, targetUrl: 'https://ci.example.invalid/1' };
}

/** The raw `gh pr view --json` payload; `patch` mutates one scenario off the green baseline. */
function ghView(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 965,
    url: `https://github.com/${REPO}/pull/965`,
    state: 'OPEN',
    isDraft: false,
    headRefOid: HEAD,
    headRefName: BRANCH,
    baseRefName: 'main',
    isCrossRepository: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'SUCCESS'), checkRun('ashlr/verify', 'COMPLETED', 'SUCCESS')],
    ...patch,
  };
}

/** The record the standing merge pass keeps for the PR (kind change, open, ledgered). */
function mergeRecord(patch: Partial<FleetMergeStateV1> = {}, prPatch: Partial<FleetPrMemo> = {}): FleetMergeStateV1 {
  const record = newFleetMergeState({
    key: 'prop-abc123',
    kind: 'change',
    proposalId: 'prop-abc123',
    revertsLandingId: null,
    repo: REPO,
    repoPath: '/mirror/phantom',
    enforcement: 'server',
    nowIso: '2026-10-28T00:00:00.000Z',
  });
  record.pr = {
    number: 965,
    nodeId: 'PR_kwDOfake965',
    repositoryId: 'R_kgDOfake',
    branch: BRANCH,
    baseBranch: 'main',
    baseSha: BASE,
    headSha: HEAD,
    treeSha: 'c'.repeat(40),
    ownerLane: false,
    ownerLaneReason: null,
    openedAt: '2026-10-28T00:00:00.000Z',
    ledgered: true,
    state: 'open',
    closedBy: null,
    nextCheckAt: null,
    checkBackoffMs: 60_000,
    checks: null,
    wouldMergeHeadSha: null,
    ...prPatch,
  };
  return { ...record, ...patch };
}

const CLASSIFY_CASES: {
  name: string;
  fixture: Record<string, unknown> | null;
  enforcement?: RepoEnforcement | null;
  class: FleetPrClass;
  reason?: string;
}[] = [
  // ── the four work-generating classes ────────────────────────────────────
  { name: 'green-ready: clean, checks green', fixture: ghView(), class: 'green-ready', reason: 'checks-green' },
  {
    name: 'green-ready: pre-receive hooks still pass',
    fixture: ghView({ mergeStateStatus: 'HAS_HOOKS' }),
    class: 'green-ready',
  },
  {
    name: 'green-ready: red NON-required check on a server repo (UNSTABLE)',
    fixture: ghView({
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: [
        checkRun('ci/test', 'COMPLETED', 'SUCCESS'),
        checkRun('deploy/preview', 'COMPLETED', 'FAILURE'),
      ],
    }),
    enforcement: 'server',
    class: 'green-ready',
  },
  {
    name: 'behind: merge state BEHIND with green checks',
    fixture: ghView({ mergeStateStatus: 'BEHIND' }),
    class: 'behind',
    reason: 'base-moved',
  },
  {
    name: 'behind: compare read says behind_by > 0 though state is CLEAN',
    fixture: ghView({ behind_by: 3 }),
    class: 'behind',
  },
  {
    name: 'behind: still behind while checks run (pending checks are moot)',
    fixture: ghView({ mergeStateStatus: 'BEHIND', statusCheckRollup: [checkRun('ci/test', 'IN_PROGRESS', null)] }),
    class: 'behind',
  },
  {
    name: 'conflicted: mergeable CONFLICTING',
    fixture: ghView({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    class: 'conflicted',
    reason: 'merge-conflict',
  },
  {
    name: 'conflicted: DIRTY alone, and it outranks a red check',
    fixture: ghView({ mergeStateStatus: 'DIRTY', statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'FAILURE')] }),
    class: 'conflicted',
  },
  {
    name: 'red-required: required check FAILURE under BLOCKED',
    fixture: ghView({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'FAILURE')] }),
    class: 'red-required',
    reason: 'required-check-failed',
  },
  {
    name: 'red-required: TIMED_OUT is red too',
    fixture: ghView({
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'SUCCESS'), checkRun('ashlr/verify', 'COMPLETED', 'TIMED_OUT')],
    }),
    class: 'red-required',
  },
  {
    name: 'red-required: a red StatusContext',
    fixture: ghView({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [statusContext('ci/test', 'FAILURE')] }),
    class: 'red-required',
  },
  {
    name: 'red-required: under local enforcement any red check gates',
    fixture: ghView({
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'SUCCESS'), checkRun('deploy/preview', 'COMPLETED', 'FAILURE')],
    }),
    enforcement: 'local',
    class: 'red-required',
  },
  {
    name: 'red-required: unknown enforcement reads every check as gating',
    fixture: ghView({
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: [checkRun('deploy/preview', 'COMPLETED', 'FAILURE')],
    }),
    enforcement: null,
    class: 'red-required',
  },
  // ── non-work classes: pending ────────────────────────────────────────────
  {
    name: 'pending: a check is still running',
    fixture: ghView({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [checkRun('ci/test', 'IN_PROGRESS', null)] }),
    class: 'pending',
    reason: 'checks-pending',
  },
  {
    name: 'pending: CANCELLED is superseded, not red',
    fixture: ghView({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'CANCELLED')] }),
    enforcement: 'local',
    class: 'pending',
  },
  {
    name: 'pending: no checks reported yet',
    fixture: ghView({ statusCheckRollup: [] }),
    class: 'pending',
    reason: 'checks-none',
  },
  {
    name: 'pending: GitHub has not computed mergeability',
    fixture: ghView({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    class: 'pending',
    reason: 'github-computing',
  },
  {
    name: 'pending: blocked on a non-check gate (green checks, BLOCKED)',
    fixture: ghView({ mergeStateStatus: 'BLOCKED' }),
    class: 'pending',
    reason: 'blocked-non-check',
  },
  { name: 'pending: draft', fixture: ghView({ isDraft: true, mergeStateStatus: 'DRAFT' }), class: 'pending', reason: 'draft' },
  {
    name: 'pending: a mergeStateStatus the enum did not name',
    fixture: ghView({ mergeStateStatus: 'SOME-FUTURE-STATE' }),
    class: 'pending',
    reason: 'unrecognised-state',
  },
  // ── non-work classes: closed / unknown ──────────────────────────────────
  { name: 'closed: merged on GitHub', fixture: ghView({ state: 'MERGED' }), class: 'closed', reason: 'pr-merged' },
  { name: 'closed: closed on GitHub', fixture: ghView({ state: 'CLOSED' }), class: 'closed', reason: 'pr-closed' },
  { name: 'unknown: the view itself is missing', fixture: null, class: 'unknown', reason: 'github-view-unreadable' },
  { name: 'unknown: cross-repository head', fixture: ghView({ isCrossRepository: true }), class: 'unknown' },
  { name: 'unknown: number missing from the JSON', fixture: ghView({ number: undefined }), class: 'unknown' },
  { name: 'unknown: head sha malformed', fixture: ghView({ headRefOid: 'not-a-sha' }), class: 'unknown' },
];

describe('fleet PR merge class from fixture gh JSON', () => {
  for (const row of CLASSIFY_CASES) {
    it(row.name, () => {
      const view = row.fixture === null ? null : parseFleetPrGhState(row.fixture);
      const got = classifyFleetPrGh(view, { enforcement: 'enforcement' in row ? row.enforcement : 'server' });
      expect(got.class).toBe(row.class);
      expect(got.work).toBe(FLEET_PR_CLASS_WORK[row.class]);
      if (row.reason !== undefined) expect(got.reason).toBe(row.reason);
    });
  }

  it('assigns refix to conflicted and red-required, drain to green-ready and behind', () => {
    expect(FLEET_PR_CLASS_WORK['green-ready']).toBe('drain');
    expect(FLEET_PR_CLASS_WORK['behind']).toBe('drain');
    expect(FLEET_PR_CLASS_WORK['conflicted']).toBe('refix');
    expect(FLEET_PR_CLASS_WORK['red-required']).toBe('refix');
    expect(FLEET_PR_CLASS_WORK['pending']).toBe('none');
    expect(FLEET_PR_CLASS_WORK['closed']).toBe('none');
    expect(FLEET_PR_CLASS_WORK['unknown']).toBe('none');
  });
});

describe('rollupFleetPrChecks (G7 conclusion semantics)', () => {
  const cases: { name: string; rollup: unknown; want: 'green' | 'red' | 'pending' | 'none' }[] = [
    { name: 'empty / missing', rollup: [], want: 'none' },
    { name: 'not an array', rollup: { state: 'SUCCESS' }, want: 'none' },
    { name: 'all green', rollup: [checkRun('a', 'COMPLETED', 'SUCCESS'), statusContext('b', 'SUCCESS')], want: 'green' },
    { name: 'neutral and skipped are green', rollup: [checkRun('a', 'COMPLETED', 'NEUTRAL'), checkRun('b', 'COMPLETED', 'SKIPPED')], want: 'green' },
    { name: 'one FAILURE is red', rollup: [checkRun('a', 'COMPLETED', 'SUCCESS'), checkRun('b', 'COMPLETED', 'FAILURE')], want: 'red' },
    { name: 'ACTION_REQUIRED is red', rollup: [checkRun('a', 'COMPLETED', 'ACTION_REQUIRED')], want: 'red' },
    { name: 'STARTUP_FAILURE is red', rollup: [checkRun('a', 'COMPLETED', 'STARTUP_FAILURE')], want: 'red' },
    { name: 'ERROR status context is red', rollup: [statusContext('a', 'ERROR')], want: 'red' },
    { name: 'in progress is pending', rollup: [checkRun('a', 'IN_PROGRESS', null)], want: 'pending' },
    { name: 'STALE is pending, not red', rollup: [checkRun('a', 'COMPLETED', 'STALE')], want: 'pending' },
    { name: 'an unreadable entry is pending, never green', rollup: [checkRun('a', 'COMPLETED', 'SUCCESS'), 'garbage'], want: 'pending' },
    { name: 'an unexpected conclusion is pending', rollup: [checkRun('a', 'COMPLETED', 'SOMETHING_NEW')], want: 'pending' },
  ];
  for (const row of cases) {
    it(row.name, () => expect(rollupFleetPrChecks(row.rollup)).toBe(row.want));
  }
});

describe('parseFleetPrGhState', () => {
  it('parses a full gh view', () => {
    const view = parseFleetPrGhState(ghView({ behind_by: 2 }));
    expect(view).toMatchObject({
      number: 965,
      state: 'OPEN',
      isDraft: false,
      headSha: HEAD,
      headRef: BRANCH,
      baseRef: 'main',
      isCrossRepository: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: 'green',
      behindBy: 2,
    });
  });

  it('rejects non-objects and PRs it cannot identify', () => {
    for (const raw of [null, 42, 'x', [], ghView({ state: 'OPENISH' }), ghView({ number: 0 }), ghView({ headRefOid: 'zz' })]) {
      expect(parseFleetPrGhState(raw)).toBeNull();
    }
  });

  it('keeps unknown mergeability / merge state instead of guessing', () => {
    const view = parseFleetPrGhState(ghView({ mergeable: 'REBASEABLE', mergeStateStatus: 7 }))!;
    expect(view.mergeable).toBe('UNKNOWN');
    expect(view.mergeStateStatus).toBe('UNKNOWN');
  });
});

describe('classifyFleetMergeStatePr (record-bound)', () => {
  const open = { state: 'ok' as const, record: mergeRecord() };
  const gh: FleetPrGhState = parseFleetPrGhState(ghView())!;

  it('classifies the recorded PR through the gh view', () => {
    expect(classifyFleetMergeStatePr(open, gh).class).toBe('green-ready');
  });

  it('uses the record enforcement for red checks (server: only BLOCKED is red-required)', () => {
    const unstable = parseFleetPrGhState(
      ghView({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [checkRun('ci/test', 'COMPLETED', 'FAILURE')] }),
    );
    expect(classifyFleetMergeStatePr(open, unstable).class).toBe('green-ready');
    const local = { state: 'ok' as const, record: mergeRecord({ enforcement: 'local' }) };
    expect(classifyFleetMergeStatePr(local, unstable).class).toBe('red-required');
  });

  it('a moved head is pending — the new head is not the verified one', () => {
    const moved = parseFleetPrGhState(ghView({ headRefOid: 'd'.repeat(40) }))!;
    const got = classifyFleetMergeStatePr(open, moved);
    expect(got.class).toBe('pending');
    expect(got.reason).toBe('head-moved');
  });

  it('a different PR number fails closed', () => {
    const other = parseFleetPrGhState(ghView({ number: 966 }))!;
    const got = classifyFleetMergeStatePr(open, other);
    expect(got.class).toBe('unknown');
    expect(got.reason).toBe('pr-mismatch');
  });

  it('a terminal record stays closed even when a stale read says open', () => {
    const terminal = { state: 'ok' as const, record: mergeRecord({}, { state: 'closed', closedBy: 'daemon' }) };
    const got = classifyFleetMergeStatePr(terminal, gh);
    expect(got.class).toBe('closed');
    expect(got.reason).toBe('record-terminal');
  });

  it('a reached outcome is terminal too', () => {
    const terminal = { state: 'ok' as const, record: mergeRecord({ outcome: 'rejected' }) };
    expect(classifyFleetMergeStatePr(terminal, gh).class).toBe('closed');
  });

  it('a corrupt record fails closed', () => {
    const got = classifyFleetMergeStatePr({ state: 'corrupt', reason: 'x' }, gh);
    expect(got.class).toBe('unknown');
    expect(got.reason).toBe('merge-state-corrupt');
  });

  it('a record without a fleet PR has nothing to classify', () => {
    const record = mergeRecord();
    record.pr = null;
    const got = classifyFleetMergeStatePr({ state: 'ok', record }, gh);
    expect(got.class).toBe('unknown');
    expect(got.reason).toBe('no-fleet-pr');
  });

  it('missing state classifies the gh view alone', () => {
    const got = classifyFleetMergeStatePr({ state: 'missing' }, gh);
    expect(got.class).toBe('green-ready');
  });
});
