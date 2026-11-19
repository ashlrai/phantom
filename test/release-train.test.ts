import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import {
  admitCiRun, allowReleasePrDispatch, assertReleaseWrite, buildTrain, cadenceMinutesFromEnv, cappedCadenceMinutes, DEFAULT_CADENCE_MINUTES, docsCarriersSynced, ENQUEUE_PULL_REQUEST,
  judgeRequiredChecks, releaseHeadBranch, releaseWriteUsesAppToken, TRAIN_JOB_CHECK_NAME,
  enqueueReleasePullRequest, hostedTrainGate, isMissingTagRef, isReleasePleaseCommit,
  successorTagConflict, refusePublishIfSuccessorConflict, publishRunFromAttestation, finalizeRetryDecision,
  finalizeRunIdentity, listFinalizeRuns, finalizeRunsQuery,
  RELEASE_GATE_RECEIPT, releaseGateReceipt,
  markWritesApplied, mergeStageDone, observeTrain, pauseReleaseTrain, readSentinel, releaseGithubCall, releaseKillDecision, releasePrMergeQueueState, selectUpdaterFeed,
  syncReleasePullRequest, UPDATE_PULL_REQUEST_BRANCH,
  TRAIN_SCHEMA, trainStepSummary, updaterFeedMatches, WEBSITE_HOOK,
  type ReleaseWrite, type TrainObservation,
} from '../src/core/release/train.js';
import { RELEASE_GATE } from '../.github/scripts/ci-release-gate.mjs';

const sha = 'a'.repeat(40);
const head = 'b'.repeat(40);
const pr = 'c'.repeat(40);
function greenCi(commit: string): Record<string, unknown> {
  return {
    'repos/ashlrai/phantom/rules/branches/master': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Merge Gate' }] } }],
    'repos/ashlrai/phantom/branches/master': { protection: { required_status_checks: { contexts: ['Merge Gate'] } } },
    [`repos/ashlrai/phantom/commits/${commit}/check-runs?filter=latest&app_id=15368&per_page=100&page=1`]: {
      total_count: 1,
      check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } }],
    },
  };
}
const message = 'chore(master): release 3.30.27 (#4130)\n\n* chore(release): sync candidate version carriers to 3.30.27\n';

function observation(overrides: Partial<TrainObservation> = {}): TrainObservation {
  return {
    now: '2026-11-09T06:00:00.000Z',
    fleetKill: 'inactive',
    autorunOff: 'inactive',
    masterSha: sha,
    masterVersion: '3.30.27',
    cadenceMinutes: 60,
    lastTaggedAt: '2026-11-09T04:00:00.000Z',
    aheadBy: 3,
    tags: [{ name: 'v3.30.27', sha: head }, { name: 'v3.30.24', sha }],
    head: { tag: 'v3.30.27', sha: head, message, ancestry: 'ancestor', committedAt: '2026-11-09T02:30:00.000Z' },
    releases: [
      { id: 3, tag_name: 'v3.30.27', draft: true, name: 'Phantom 3.30.27', body: 'notes', created_at: '2026-11-09T02:36:49Z', assets: [] },
      { id: 2, tag_name: 'v3.30.26', draft: true, name: 'Phantom 3.30.26', body: 'older', created_at: '2026-11-08T23:22:29Z', assets: [] },
      { id: 1, tag_name: 'v3.30.24', draft: false, name: 'Phantom 3.30.24', body: 'published', created_at: '2026-11-07T04:06:15Z', assets: [{ name: 'latest.json', created_at: '2026-11-07T04:06:15Z' }] },
    ],
    openReleasePr: null,
    pullChecks: null,
    candidateCi: 'green',
    build: null,
    buildPending: false,
    attest: null,
    attestPending: false,
    audit: null,
    feedVersion: null,
    npmPublished: false,
    npmAt: null,
    docsSynced: true,
    ...overrides,
  };
}

describe('release train', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('runs the workflow commands directly under Node type stripping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'train-node-'));
    dirs.push(dir);
    const run = (...args: string[]) => spawnSync(process.execPath,
      ['--experimental-strip-types', 'src/core/release/train.ts', ...args],
      { encoding: 'utf8', env: { HOME: dir, GITHUB_ACTIONS: 'true' } });
    const guard = run('guard');
    expect(guard.status).toBe(1);
    expect(JSON.parse(guard.stdout)).toMatchObject({ proceed: false, reason: 'repo-variable-unset' });
    expect(guard.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    const train = run('run', '--apply', '--out', join(dir, 'release-state.json'));
    expect(train.status).toBe(1);
    expect(train.stderr).toContain('github token unavailable');
    expect(train.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('fails closed on the hosted repo variable unless it is on', () => {
    expect(hostedTrainGate({ GITHUB_ACTIONS: 'true' })).toEqual({ proceed: false, reason: 'repo-variable-unset' });
    expect(hostedTrainGate({ GITHUB_ACTIONS: 'true', PHANTOM_RELEASE_TRAIN: 'off' })).toEqual({ proceed: false, reason: 'repo-variable-off' });
    expect(hostedTrainGate({ GITHUB_ACTIONS: 'true', PHANTOM_RELEASE_TRAIN: 'on' })).toEqual({ proceed: true, reason: 'repo-variable-on' });
    expect(hostedTrainGate({})).toBeNull();
    const calls: string[][] = [];
    const logs: string[] = [];
    pauseReleaseTrain(() => { calls.push(['gh', 'variable', 'set', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom', '--body', 'off']); throw new Error('gh down'); }, mkdtempSync(join(tmpdir(), 'release-off-')), (line) => logs.push(line));
    expect(logs.join(' ')).toContain('PHANTOM_RELEASE_TRAIN was not set off');
    pauseReleaseTrain((file, args) => { calls.push([file, ...args]); return ''; }, mkdtempSync(join(tmpdir(), 'release-off-')), () => undefined);
    expect(calls.some((argv) => argv.join(' ') === 'gh variable set PHANTOM_RELEASE_TRAIN -R ashlrai/phantom --body off')).toBe(true);
  });

  it('admits only sanctioned ci runs', () => {
    const repo = { full_name: 'ashlrai/phantom' };
    const good = { head_sha: head, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', repository: repo, head_repository: repo, head_branch: 'v3.30.28' };
    expect(admitCiRun(good, head, 'v3.30.28')).toBe(true);
    expect(admitCiRun({ ...good, event: 'push' }, head, 'v3.30.28')).toBe(false);
    expect(admitCiRun({ ...good, path: '.github/workflows/other.yml' }, head, 'v3.30.28')).toBe(false);
    expect(admitCiRun({ ...good, repository: { full_name: 'other/phantom' } }, head, 'v3.30.28')).toBe(false);
  });

  it('accepts an ancestor or head with green CI and rejects red or diverged candidates', () => {
    expect(judgeRequiredChecks(['Merge Gate'], [{ name: 'Merge Gate', status: 'completed', conclusion: 'success', appId: 15368 }])).toBe('green');
    expect(judgeRequiredChecks(['Merge Gate'], [{ name: 'Merge Gate', status: 'completed', conclusion: 'failure', appId: 15368 }])).toBe('red');
    expect(releaseHeadBranch('master')).toBe(true);
    expect(releaseHeadBranch('v3.30.27')).toBe(true);
    expect(releaseHeadBranch('refs/heads/v3.30.27')).toBe(false);
    expect(releaseHeadBranch('refs/tags/v3.30.27')).toBe(false);
    expect(releaseHeadBranch('v1')).toBe(false);
    const ancestor = buildTrain(observation());
    expect(ancestor.exitCode).toBe(0);
    expect(ancestor.state.sha).toBe(head);
    expect(ancestor.state.steps.build?.reason).toBeUndefined();
    expect(ancestor.state.advance).toBeUndefined();
    expect(ancestor.writes.find((write) => write.path.endsWith('/ci.yml/dispatches'))?.body).toEqual({ ref: 'v3.30.27', inputs: { release_gate: 'true' } });
    expect(ancestor.writes.find((write) => write.path.endsWith('/dependency-audit.yml/dispatches'))?.body).toEqual({ ref: 'v3.30.27', inputs: {} });
    expect(ancestor.writes.some((write) => write.path.includes('release-please.yml'))).toBe(false);
    const current = buildTrain(observation({ masterSha: head, aheadBy: 0 }));
    expect(current.exitCode).toBe(0);
    expect(current.writes.find((write) => write.path.endsWith('/ci.yml/dispatches'))?.body).toEqual({ ref: 'v3.30.27', inputs: { release_gate: 'true' } });
    const red = buildTrain(observation({ candidateCi: 'red' }));
    expect(red).toMatchObject({ exitCode: 1, writes: [], state: { reason: 'candidate-ci-red' } });
    const diverged = buildTrain(observation({
      head: { tag: 'v3.30.27', sha: head, message, ancestry: 'diverged', compareStatus: 'diverged', committedAt: null },
    }));
    expect(diverged.exitCode).toBe(1);
    expect(diverged.writes).toEqual([]);
    expect(diverged.state.reason).toContain('candidate-refused');
    expect(diverged.state.reason).toContain('compare_not_ahead: diverged');
  });

  it('judges only named required checks and does not treat pending or later suites as red', () => {
    const gate = (status: string, conclusion: string | null) => (
      { name: 'Merge Gate', status, conclusion, appId: 15368 }
    );
    const trainJob = (conclusion: string) => (
      { name: TRAIN_JOB_CHECK_NAME, status: 'completed', conclusion, appId: 15368 }
    );
    expect(judgeRequiredChecks(['Merge Gate'], [
      gate('completed', 'success'),
      gate('completed', 'failure'),
    ])).toBe('green');
    expect(judgeRequiredChecks(['Merge Gate'], [
      gate('completed', 'success'),
      trainJob('failure'),
    ])).toBe('green');
    expect(judgeRequiredChecks(['Merge Gate', TRAIN_JOB_CHECK_NAME], [
      gate('completed', 'success'),
      trainJob('failure'),
    ])).toBe('green');
    expect(judgeRequiredChecks([TRAIN_JOB_CHECK_NAME], [trainJob('failure')])).toBe('unknown');
    expect(judgeRequiredChecks(['Merge Gate'], [gate('in_progress', null)])).toBe('pending');
    expect(judgeRequiredChecks(['Merge Gate'], [gate('queued', null)])).toBe('pending');
    expect(judgeRequiredChecks(['Merge Gate'], [
      gate('completed', 'success'),
      gate('in_progress', null),
    ])).toBe('pending');
    expect(judgeRequiredChecks(['Merge Gate'], [gate('completed', 'failure')])).toBe('red');
    expect(judgeRequiredChecks(['Merge Gate'], [])).toBe('pending');
    const pendingPlan = buildTrain(observation({ candidateCi: 'pending' }));
    expect(pendingPlan.exitCode).toBe(0);
    expect(pendingPlan.state.stopped).toBe(false);
    expect(pendingPlan.state.steps.build?.reason).toBe('candidate-ci-pending');
    expect(pendingPlan.writes.some((write) => write.path.endsWith('/ci.yml/dispatches'))).toBe(false);
  });

  it('stops redispatching release CI when the master push CI for the tag SHA concluded red', () => {
    // v3.30.34: the advisory Quick typecheck failed on the push run, so Merge Gate
    // is green but release-build reuses only a green exact-source push run and
    // every dispatched CI run ends with no ashlr-build artifact.
    const redPush = buildTrain(observation({ pushCiRed: true }));
    expect(redPush.exitCode).toBe(0);
    expect(redPush.state.steps.build).toEqual({ status: 'pending', reason: 'candidate-push-ci-red' });
    expect(redPush.writes.some((write) => write.path.endsWith('/ci.yml/dispatches'))).toBe(false);
    // An existing build still advances to attest.
    const built = buildTrain(observation({ pushCiRed: true, build: { runId: 5, attempt: 1, artifactId: 9, completedAt: null } }));
    expect(built.state.steps.build?.status).toBe('complete');
  });

  describe('fix forward past a candidate whose push CI is red', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/release-train/v3.30.34-push-ci-red.json'), 'utf8')) as {
      stuckPlan: { version: string; tag: string; sha: string; next: string; build: { status: string; reason: string } };
      observation: TrainObservation;
    };
    const stuck = fixture.observation;
    const dispatchPath = 'repos/ashlrai/phantom/actions/workflows/release-please.yml/dispatches';
    const successorPr = { number: 9, nodeId: 'PR_kwDO_next', version: '3.30.35', headSha: pr, headRef: 'release-please--master', mergeable: 'MERGEABLE', state: 'OPEN' as const, queued: false };

    it('reproduces the stuck v3.30.34 plan when master gate evidence is absent', () => {
      const { masterCi: _masterCi, ...withoutGate } = stuck;
      const plan = buildTrain(withoutGate);
      expect(plan.state).toMatchObject({
        version: fixture.stuckPlan.version, tag: fixture.stuckPlan.tag, sha: fixture.stuckPlan.sha, next: fixture.stuckPlan.next,
      });
      expect(plan.state.steps.build).toEqual(fixture.stuckPlan.build);
      expect(plan.state.advance).toBeUndefined();
    });

    it('skips v3.30.34 in the plan only and plans 3.30.35 from green master', () => {
      const plan = buildTrain(stuck);
      expect(plan.exitCode).toBe(0);
      expect(plan.state).toMatchObject({
        stopped: false, reason: 'fix-forward-from-master', version: '3.30.35', tag: 'v3.30.35', sha: stuck.masterSha, next: 'release-pr',
        advance: { action: 'advance-from-master', version: '3.30.35', sha: stuck.masterSha, reason: 'candidate-push-ci-red' },
        superseded: ['v3.30.34'],
      });
      expect(plan.state.skippedTags).toEqual([{
        tag: 'v3.30.34',
        reason: `candidate-push-ci-red: tag=v3.30.34 sha=${fixture.stuckPlan.sha} superseded_by=v3.30.35 master=${stuck.masterSha}`,
      }]);
      // No Release PR is open yet, so the only write asks the Release PR workflow to cut one.
      expect(plan.writes).toEqual([{ method: 'POST', path: dispatchPath, body: { ref: 'master', inputs: {} } }]);
      // The dead draft and tag are never written: no PATCH, no DELETE, no tag ref, no CI redispatch.
      const serialized = JSON.stringify(plan.writes);
      expect(plan.writes.some((write) => write.method === 'PATCH')).toBe(false);
      expect(serialized).not.toMatch(/DELETE|git\/refs|releases\/34|ci\.yml|admin|bypass|sign|notar/);
      expect(plan.state.steps['release-pr']).toEqual({ status: 'pending', reason: 'release-pr-dispatched' });
      for (const step of ['merge', 'tag', 'build', 'attest', 'npm', 'feed', 'docs', 'finalize']) {
        expect(plan.state.steps[step]?.status).toBe('pending');
      }
      expect(plan.state.steps.sign).toEqual({ status: 'pending', reason: 'mac-release-autorun' });
      expect(plan.state.steps.notarize).toEqual({ status: 'pending', reason: 'mac-release-autorun' });
      // Release PR completion must still not recurse into another dispatch.
      expect(allowReleasePrDispatch(dispatchPath, 'false')).toBe(false);
      expect(markWritesApplied(plan.state).next).toBe('release-pr');
    });

    it('enqueues a green 3.30.35 release PR and waits on one that is not ready', () => {
      const ready = buildTrain({ ...stuck, openReleasePr: successorPr, pullChecks: { pending: 0, failing: 0 } });
      expect(ready.writes).toEqual([enqueueReleasePullRequest('PR_kwDO_next')]);
      expect(ready.state.steps['release-pr']?.reason).toBe('release-pr-enqueued');
      // An unaddressed merge-queue ejection syncs the head instead of re-enqueueing stale evidence.
      const syncing = buildTrain({ ...stuck, openReleasePr: { ...successorPr, branchSyncDue: true }, pullChecks: { pending: 0, failing: 0 } });
      expect(syncing.writes).toEqual([syncReleasePullRequest('PR_kwDO_next', pr)]);
      expect(syncing.state.steps['release-pr']?.reason).toBe('release-pr-syncing');
      const checking = buildTrain({ ...stuck, openReleasePr: successorPr, pullChecks: { pending: 2, failing: 0 } });
      expect(checking.writes).toEqual([]);
      expect(checking.state).toMatchObject({ version: '3.30.35', next: 'release-pr', steps: { 'release-pr': { reason: 'release-pr-checks-pending' } } });
      const queued = buildTrain({ ...stuck, openReleasePr: { ...successorPr, queued: true }, pullChecks: { pending: 0, failing: 0 } });
      expect(queued.writes).toEqual([]);
      expect(queued.state.steps['release-pr']?.reason).toBe('release-pr-queued');
      const early = buildTrain({ ...stuck, lastTaggedAt: '2026-11-16T06:29:00.000Z' });
      expect(early.writes).toEqual([]);
      expect(early.state.steps['release-pr']?.reason).toBe('release-cadence-wait');
    });

    it('keeps earlier skipped tags ahead of the fix-forward entry', () => {
      const plan = buildTrain({ ...stuck, skippedTags: [{ tag: 'v3.30.29', reason: 'release_message_mismatch' }] });
      expect(plan.state.skippedTags?.map((item) => item.tag)).toEqual(['v3.30.29', 'v3.30.34']);
      expect(plan.state.skippedTags?.[1]?.reason).toContain('candidate-push-ci-red: tag=v3.30.34');
    });

    it.each([
      ['master gate pending', { masterCi: 'pending' as const }],
      ['master gate red', { masterCi: 'red' as const }],
      ['master gate unknown', { masterCi: 'unknown' as const }],
      ['push CI not red', { pushCiRed: false }],
      ['a build already exists', { build: { runId: 5, attempt: 1, artifactId: 9, completedAt: null } }],
      ['a build is still running', { buildPending: true }],
      ['master is the candidate', { masterSha: '8060b4bd00000000000000000000000000000000', head: { ...stuck.head!, ancestry: 'identical' as const } }],
      ['master already carries a newer release commit', { masterVersion: '3.30.35' }],
      ['npm already has the candidate', { npmPublished: true }],
    ])('does not fix forward when %s', (_label, overrides: Partial<TrainObservation>) => {
      const plan = buildTrain({ ...stuck, ...overrides });
      expect(plan.state.advance).toBeUndefined();
      expect(plan.state.tag).not.toBe('v3.30.35');
      expect(plan.writes.some((write) => write.path === dispatchPath)).toBe(false);
    });

    it('does not fix forward past a published candidate', () => {
      const releases = stuck.releases.map((row) => row.tag_name === 'v3.30.34' ? { ...row, draft: false } : row);
      expect(buildTrain({ ...stuck, releases }).state.advance).toBeUndefined();
    });

    it('reads the master fast gate only for a stuck candidate and carries it into the plan', async () => {
      const candidate = fixture.stuckPlan.sha;
      const master = stuck.masterSha;
      const pkg = (version: string) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version })).toString('base64') });
      const repo = { full_name: 'ashlrai/phantom' };
      const pushRun = (conclusion: string) => ({
        id: 43807308941, run_attempt: 1, head_sha: candidate, event: 'push', head_branch: 'master', path: '.github/workflows/ci.yml',
        status: 'completed', conclusion, repository: repo, head_repository: repo,
      });
      const reads: string[] = [];
      const observe = (conclusion: string, masterGate: 'success' | 'failure') => observeTrain(async (path) => {
        reads.push(path);
        const data: Record<string, unknown> = {
          'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
          'repos/ashlrai/phantom/commits/master': { sha: master },
          [`repos/ashlrai/phantom/contents/package.json?ref=${master}`]: pkg('3.30.34'),
          'repos/ashlrai/phantom/git/ref/tags/v3.30.34': { ref: 'refs/tags/v3.30.34', object: { type: 'commit', sha: candidate } },
          [`repos/ashlrai/phantom/commits/${candidate}`]: { commit: { message: stuck.head!.message, committer: { date: '2026-11-16T02:00:00.000Z' } } },
          [`repos/ashlrai/phantom/compare/${candidate}...${master}`]: { status: 'ahead', ahead_by: 4 },
          'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: 'v3.30.34', commit: { sha: candidate } }],
          'repos/ashlrai/phantom/releases?per_page=100&page=1': [{ id: 34, tag_name: 'v3.30.34', draft: true, name: 'Phantom 3.30.34', body: 'notes', created_at: '2026-11-16T02:05:00Z', assets: [] }],
          'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [],
          [`repos/ashlrai/phantom/actions/workflows/ci.yml/runs?head_sha=${candidate}&per_page=20`]: { total_count: 1, workflow_runs: [pushRun(conclusion)] },
          ...greenCi(candidate),
          [`repos/ashlrai/phantom/commits/${master}/check-runs?filter=latest&app_id=15368&per_page=100&page=1`]: {
            total_count: 1, check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: masterGate, app: { id: 15368 } }],
          },
        };
        if (Object.hasOwn(data, path)) return data[path];
        if (path.includes('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
        if (path.startsWith('registry/')) return null;
        throw new Error(`unexpected ${path}`);
      }, '2026-11-16T06:30:00.000Z', 5, { fleet: 'inactive', autorun: 'inactive' });

      const red = await observe('failure', 'success');
      expect(red).toMatchObject({ pushCiRed: true, candidateCi: 'green', masterCi: 'green' });
      expect(buildTrain(red).state).toMatchObject({ version: '3.30.35', sha: master, superseded: ['v3.30.34'] });
      const gateRed = await observe('failure', 'failure');
      expect(gateRed.masterCi).toBe('red');
      expect(buildTrain(gateRed).state).toMatchObject({ version: '3.30.34', next: 'build' });

      reads.length = 0;
      const green = await observe('success', 'success');
      expect(green.pushCiRed).toBe(false);
      expect(green.masterCi).toBeUndefined();
      expect(reads.some((path) => path.startsWith(`repos/ashlrai/phantom/commits/${master}/check-runs`))).toBe(false);
    });
  });

  it('does not recursively dispatch Release PR from its own completion', () => {
    const path = 'repos/ashlrai/phantom/actions/workflows/release-please.yml/dispatches';
    expect(allowReleasePrDispatch(path, 'false')).toBe(false);
    expect(allowReleasePrDispatch(path, 'true')).toBe(true);
    expect(allowReleasePrDispatch('graphql', 'false')).toBe(true);
  });

  it('does not plan a successor without commits after the tag or before cadence', () => {
    for (const overrides of [{ aheadBy: 0 }, { lastTaggedAt: '2026-11-09T05:59:00Z' }]) {
      const plan = buildTrain(observation(overrides));
      expect(plan.state.advance).toBeUndefined();
      expect(plan.writes.some(write => write.path.includes('release-please.yml'))).toBe(false);
    }
  });

  it('fails closed unless both kill sentinels are proven absent', () => {
    expect(releaseKillDecision('inactive', 'inactive')).toEqual({ proceed: true, reason: 'kill-inactive' });
    expect(releaseKillDecision('active', 'inactive').proceed).toBe(false);
    expect(releaseKillDecision('unknown', 'inactive').proceed).toBe(false);
    expect(releaseKillDecision('inactive', 'active').reason).toBe('release-autorun-off');
    expect(releaseKillDecision('inactive', 'unknown').proceed).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'release-kill-'));
    dirs.push(dir);
    expect(readSentinel(join(dir, 'missing'))).toBe('inactive');
    writeFileSync(join(dir, 'KILL'), 'kill switch active\n');
    expect(readSentinel(join(dir, 'KILL'))).toBe('active');
    symlinkSync(join(dir, 'KILL'), join(dir, 'link'));
    expect(readSentinel(join(dir, 'link'))).toBe('unknown');
    expect(buildTrain(observation({ fleetKill: 'active' }))).toMatchObject({ exitCode: 1, writes: [] });
  });

  it('honors configured cadence minutes and only cuts a green release-please pull request', () => {
    expect(cappedCadenceMinutes(30)).toBe(30);
    expect(cappedCadenceMinutes(60)).toBe(60);
    expect(cappedCadenceMinutes(120)).toBe(120);
    expect(() => cappedCadenceMinutes(0)).toThrow(/cadence/);
    expect(DEFAULT_CADENCE_MINUTES).toBe(5);
    expect(cadenceMinutesFromEnv(undefined)).toBe(5);
    expect(cadenceMinutesFromEnv('')).toBe(5);
    expect(cadenceMinutesFromEnv('5')).toBe(5);
    expect(cadenceMinutesFromEnv('1')).toBe(1);
    expect(cadenceMinutesFromEnv('60')).toBe(60);
    expect(() => cadenceMinutesFromEnv('0')).toThrow(/cadence/);
    expect(() => cadenceMinutesFromEnv('4.5')).toThrow(/cadence/);
    const early = buildTrain(observation({
      lastTaggedAt: '2026-11-09T05:30:00.000Z',
      openReleasePr: { number: 9, nodeId: 'PR_kwDO_test', version: '3.30.28', headSha: pr, headRef: 'release-please--master', mergeable: 'MERGEABLE', state: 'OPEN', queued: false },
      pullChecks: { pending: 0, failing: 0 },
    }));
    expect(early.writes.some((write) => write.path === 'graphql' || write.path.endsWith('/merge'))).toBe(false);
    const due = buildTrain(observation({
      masterVersion: '3.30.27',
      openReleasePr: { number: 9, nodeId: 'PR_kwDO_test', version: '3.30.28', headSha: pr, headRef: 'release-please--master', mergeable: 'MERGEABLE', state: 'OPEN', queued: false },
      pullChecks: { pending: 0, failing: 0 },
    }));
    const merge = due.writes.find((write) => write.path === 'graphql');
    expect(merge).toEqual(enqueueReleasePullRequest('PR_kwDO_test'));
    expect(due.writes.some(write => write.path.includes('release-please.yml'))).toBe(false);
    expect(due.state.advance).toBeUndefined();
    expect(ENQUEUE_PULL_REQUEST).toContain('enqueuePullRequest');
    // The declared GraphQL variable must match the variables key sent, or GitHub rejects $id as an invalid ID! (v3.30.35 train runs 43858601478, 43858533926).
    const declared = [...ENQUEUE_PULL_REQUEST.matchAll(/\$(\w+):/g)].map((m) => m[1]);
    expect(declared).toEqual(Object.keys((merge as { body: { variables: Record<string, string> } }).body.variables));
    expect(JSON.stringify(due.writes)).not.toMatch(/admin|bypass|\/merge/);
    expect(mergeStageDone('OPEN')).toBe(false);
    expect(mergeStageDone('MERGED')).toBe(true);
    expect(due.state.steps.merge?.status).toBe('complete');
    const blocked = buildTrain(observation({
      openReleasePr: { number: 9, nodeId: 'PR_kwDO_test', version: '3.30.28', headSha: pr, headRef: 'release-please--master', mergeable: 'MERGEABLE', state: 'OPEN', queued: false },
      pullChecks: { pending: 1, failing: 0 },
    }));
    expect(blocked.writes.some((write) => write.path === 'graphql')).toBe(false);
  });

  it('marks older drafts superseded and never deletes or publishes them', () => {
    const plan = buildTrain(observation());
    expect(plan.exitCode).toBe(0);
    const patches = plan.writes.filter((write) => write.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ path: 'repos/ashlrai/phantom/releases/2', body: { draft: true, prerelease: false } });
    expect(patches[0]?.body.body).toContain('Superseded by v3.30.27. This draft stays unpublished.');
    expect(plan.writes.some((write) => write.path.includes('/releases/1'))).toBe(false);
    expect(JSON.stringify(plan.writes)).not.toContain('DELETE');
    const again = buildTrain(observation({
      releases: observation().releases.map((row) => row.id === 2 ? { ...row, body: `${row.body}\n\nSuperseded by v3.30.27. This draft stays unpublished.\n` } : row),
    }));
    expect(again.writes.filter((write) => write.method === 'PATCH')).toHaveLength(0);
    expect(again.state.superseded).toEqual(['v3.30.26']);
  });

  it('refuses a newest tag that is not a release-please ancestor', () => {
    expect(isReleasePleaseCommit(message, '3.30.27')).toBe(true);
    expect(docsCarriersSynced(message, '3.30.27')).toBe(true);
    expect(buildTrain(observation({ head: { tag: 'v3.30.27', sha: head, message: 'feat: something\n', ancestry: 'ancestor', committedAt: null } })).exitCode).toBe(1);
    expect(buildTrain(observation({ head: { tag: 'v3.30.27', sha: head, message, ancestry: 'diverged', committedAt: null } })).state.reason).toContain('candidate-refused');
  });

  it('explains each candidate refusal and refuses an existing next tag', () => {
    const base = observation();
    expect(buildTrain({ ...base, head: { ...base.head!, ancestry: 'diverged', compareStatus: 'diverged' } }).state.reason).toContain('compare_not_ahead: diverged');
    expect(buildTrain({ ...base, head: { ...base.head!, sha: '' } }).state.reason).toContain('tag_sha_empty');
    const reason = buildTrain({ ...base, head: { ...base.head!, message: 'bridge: unrelated\nbody' } }).state.reason;
    expect(reason).toContain('release_message_mismatch: tag=v3.30.27');
    expect(reason).toContain('first_line="bridge: unrelated"');
    expect(reason).toContain('expected=chore(<scope>): release 3.30.27');
    expect(buildTrain({ ...base, tags: [...base.tags, { name: 'v3.30.28', sha: head }], skippedTags: [{ tag: 'v3.30.28', reason: 'release_message_mismatch' }] }).state.reason).toBe('duplicate_tag');
  });

  it('refuses a second train publish when a strictly-greater tag appears mid-flight', () => {
    const ready = observation({
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
      attest: { runId: 22, attempt: 1, artifactId: 202, completedAt: '2026-11-09T03:10:00.000Z' },
      audit: { runId: 33, attempt: 1 },
      npmPublished: false,
    });
    const first = buildTrain(ready);
    const publish = first.writes.filter((write) => write.path.endsWith('/publish-canonical-npm.yml/dispatches'));
    expect(publish).toHaveLength(1);
    expect(successorTagConflict(ready.masterVersion, ready.tags)).toBe(false);

    // A second train observes a newer tag that landed while the first was still publishing.
    const raced = {
      ...ready,
      tags: [...ready.tags, { name: 'v3.30.28', sha: 'd'.repeat(40) }],
      skippedTags: [{ tag: 'v3.30.28', reason: 'release_message_mismatch' }],
    };
    expect(successorTagConflict(raced.masterVersion, raced.tags)).toBe(true);
    expect(buildTrain(raced).state.reason).toBe('duplicate_tag');
    expect(buildTrain(raced).writes).toEqual([]);
    const remaining = refusePublishIfSuccessorConflict(first.writes, raced);
    expect(remaining.find((write) => write.path.endsWith('/publish-canonical-npm.yml/dispatches'))).toBeUndefined();
    expect(refusePublishIfSuccessorConflict(first.writes, ready)).toEqual(first.writes);
  });

  it('admits a tagged sha from its package version and release-gate receipt', () => {
    expect([...RELEASE_GATE_RECEIPT]).toEqual([...RELEASE_GATE]);
    const runs = RELEASE_GATE_RECEIPT.map(([name]) => ({ name, status: 'completed', conclusion: 'success', appId: 15368 }));
    expect(releaseGateReceipt(runs)).toBe('green');
    expect(releaseGateReceipt(runs.map((run) => run.name === 'Merge Gate' ? { ...run, conclusion: 'skipped' } : run))).toBe('red');
    expect(releaseGateReceipt(runs.flatMap((run) => run.name === 'Desktop release smoke'
      ? [run, { ...run, conclusion: 'skipped' }] : [run]))).toBe('green');
    expect(releaseGateReceipt(runs.filter((run) => run.name !== 'Release suites (build + signing path)'))).toBe('pending');
    const tagged = 'e'.repeat(40);
    const older = 'f'.repeat(40);
    const headRow = {
      tag: 'v3.30.35', sha: tagged,
      message: 'ci(release): RELEASE-GATE-SPLIT-3 accept push-scoped checks (#6365)\n',
      packageVersion: '3.30.35', releaseGate: 'green' as const,
      ancestry: 'ancestor' as const, committedAt: '2026-11-16T18:26:53Z',
    };
    const plan = buildTrain(observation({
      masterVersion: '3.30.35',
      tags: [{ name: 'v3.30.35', sha: tagged }, { name: 'v3.30.34', sha: older }],
      head: headRow,
      releases: [
        { id: 35, tag_name: 'v3.30.35', draft: true, name: 'Phantom 3.30.35', body: 'notes', created_at: '2026-11-16T18:30:00Z', assets: [] },
        { id: 34, tag_name: 'v3.30.34', draft: true, name: 'Phantom 3.30.34', body: 'held', created_at: '2026-11-15T00:00:00Z', assets: [] },
      ],
    }));
    expect(plan.exitCode).toBe(0);
    expect(plan.state).toMatchObject({ tag: 'v3.30.35', sha: tagged, version: '3.30.35' });
    expect(JSON.stringify(plan.writes)).not.toContain('releases/34');
    expect(JSON.stringify(plan.writes)).not.toContain('git/refs');
    expect(JSON.stringify(plan.writes)).not.toContain('v3.30.34');
    const dispatch = plan.writes.find((write) => write.path.endsWith('/ci.yml/dispatches'));
    expect(dispatch && dispatch.method === 'POST' && 'ref' in dispatch.body && dispatch.body.ref).toBe('v3.30.35');
    const held = buildTrain(observation({
      masterVersion: '3.30.35',
      tags: [{ name: 'v3.30.35', sha: tagged }],
      head: { ...headRow, releaseGate: 'pending' },
      releases: [],
    }));
    expect(held.exitCode).toBe(1);
    expect(held.state.reason).toContain('release_message_mismatch: tag=v3.30.35');
    expect(held.writes).toEqual([]);
  });

  it('selects a newer tagged sha over v3.30.34 when the receipt is green', async () => {
    const tagged = 'e'.repeat(40);
    const older = 'f'.repeat(40);
    const version = '3.30.35';
    const pkg = (value: string) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version: value })).toString('base64') });
    const names = RELEASE_GATE_RECEIPT.map(([name]) => name);
    const data: Record<string, unknown> = {
      'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
      [`repos/ashlrai/phantom/commits/${sha}`]: { sha, commit: { message: 'merge', committer: { date: '2026-11-16T19:00:00Z' } } },
      'repos/ashlrai/phantom/commits/master': { sha },
      [`repos/ashlrai/phantom/contents/package.json?ref=${sha}`]: pkg(version),
      [`repos/ashlrai/phantom/contents/package.json?ref=${tagged}`]: pkg(version),
      [`repos/ashlrai/phantom/contents/package.json?ref=${older}`]: pkg('3.30.34'),
      'repos/ashlrai/phantom/git/ref/tags/v3.30.35': { ref: 'refs/tags/v3.30.35', object: { type: 'commit', sha: tagged } },
      [`repos/ashlrai/phantom/commits/${tagged}`]: { sha: tagged, commit: { message: 'ci(release): RELEASE-GATE-SPLIT-3 accept push-scoped checks (#6365)\n', committer: { date: '2026-11-16T18:26:53Z' } } },
      [`repos/ashlrai/phantom/commits/${older}`]: { sha: older, commit: { message: 'chore(master): release 3.30.34 (#1)\n', committer: { date: '2026-11-15T00:00:00Z' } } },
      [`repos/ashlrai/phantom/compare/${tagged}...${sha}`]: { status: 'ahead', ahead_by: 2 },
      'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: 'v3.30.35', commit: { sha: tagged } }, { name: 'v3.30.34', commit: { sha: older } }],
      [`repos/ashlrai/phantom/commits?sha=${tagged}&per_page=30`]: [{ commit: { message: 'ci(release): RELEASE-GATE-SPLIT-3 accept push-scoped checks (#6365)' } }],
      'repos/ashlrai/phantom/releases?per_page=100&page=1': [
        { id: 35, tag_name: 'v3.30.35', draft: true, name: 'Phantom 3.30.35', body: 'notes', created_at: '2026-11-16T18:30:00Z', assets: [] },
        { id: 34, tag_name: 'v3.30.34', draft: true, name: 'Phantom 3.30.34', body: 'held', created_at: '2026-11-15T00:00:00Z', assets: [] },
      ],
      'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [],
      [`repos/ashlrai/phantom/actions/workflows/ci.yml/runs?head_sha=${tagged}&per_page=20`]: { total_count: 0, workflow_runs: [] },
      [`repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/runs?head_sha=${tagged}&per_page=10`]: { total_count: 0, workflow_runs: [] },
      'registry/npm/@ashlr/phantom/3.30.35': null,
      ...greenCi(tagged),
      [`repos/ashlrai/phantom/commits/${tagged}/check-runs?filter=latest&app_id=15368&per_page=100&page=1`]: {
        total_count: names.length,
        check_runs: names.map((name) => ({ name, status: 'completed', conclusion: 'success', app: { id: 15368 } })),
      },
    };
    const observed = await observeTrain(async (path) => {
      if (Object.hasOwn(data, path)) return data[path];
      if (path.includes('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
      if (path.startsWith('registry/')) return null;
      throw new Error(`unexpected ${path}`);
    }, '2026-11-16T19:10:00.000Z', 60, { fleet: 'inactive', autorun: 'inactive' });
    expect(observed.head).toMatchObject({ tag: 'v3.30.35', sha: tagged, packageVersion: '3.30.35', releaseGate: 'green' });
    expect(observed.skippedTags ?? []).toEqual([]);
    const plan = buildTrain(observed);
    expect(plan.state).toMatchObject({ tag: 'v3.30.35', sha: tagged, version: '3.30.35' });
    expect(JSON.stringify(plan.writes)).not.toContain('releases/34');
    expect(JSON.stringify(plan.writes)).not.toContain('v3.30.34');
    expect(JSON.stringify(plan.writes)).not.toContain('git/refs');
  });

  it('admits a tag on a later merge when the release-please commit is its ancestor', () => {
    const later = { tag: 'v3.30.27', sha: head, message: 'bridge(RQ-X): notes (#1)\n', ancestry: 'ancestor' as const, committedAt: null };
    expect(buildTrain(observation({ head: later })).state.reason).toContain('candidate-refused');
    expect(buildTrain(observation({ head: { ...later, releaseMessage: message } })).exitCode).toBe(0);
    expect(buildTrain(observation({ head: { ...later, releaseMessage: 'chore(master): release 3.30.26 (#1)', ancestry: 'diverged' } })).exitCode).toBe(1);
  });

  it('finds the release commit under a tag that landed on a later merge', async () => {
    const later = 'd'.repeat(40);
    const pkg = (version: string) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version })).toString('base64') });
    const run = (version: string, rows: unknown) => observeTrain(async (path) => {
      const data: Record<string, unknown> = {
        'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
        'repos/ashlrai/phantom/commits/master': { sha },
        [`repos/ashlrai/phantom/contents/package.json?ref=${sha}`]: pkg('3.30.27'),
        [`repos/ashlrai/phantom/contents/package.json?ref=${later}`]: pkg(version),
        'repos/ashlrai/phantom/git/ref/tags/v3.30.27': { ref: 'refs/tags/v3.30.27', object: { type: 'commit', sha: later } },
        [`repos/ashlrai/phantom/commits/${later}`]: { sha: later, commit: { message: 'bridge: notes', committer: { date: '2026-11-09T02:30:00.000Z' } } },
        [`repos/ashlrai/phantom/compare/${later}...${sha}`]: { status: 'ahead', ahead_by: 1 },
        'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: 'v3.30.27', commit: { sha: later } }],
        [`repos/ashlrai/phantom/commits?sha=${later}&per_page=30`]: rows,
        'repos/ashlrai/phantom/releases?per_page=100&page=1': [],
        'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [],
        ...greenCi(later),
      };
      if (Object.hasOwn(data, path)) return data[path];
      if (path.includes('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
      if (path.startsWith('registry/')) return null;
      throw new Error(`unexpected ${path}`);
    }, '2026-11-09T06:00:00.000Z', 60, { fleet: 'inactive', autorun: 'inactive' });
    const rows = [{ commit: { message: 'bridge: notes' } }, { commit: { message } }];
    expect((await run('3.30.27', rows)).head?.releaseMessage).toBe(message);
    expect((await run('3.30.26', rows)).head?.releaseMessage).toBeUndefined();
    expect((await run('3.30.27', [{ commit: { message: 'bridge: notes' } }])).head?.releaseMessage).toBeUndefined();
  });

  it.each([
    ['v3.30.28', '5d9e9350', 'bridge(RQ-SWE5-FRESH-JUDGE): changes (#4153)', 'v3.30.27', message],
    ['v3.30.25', 'e18df2ff', 'bridge: changes (#4098)', 'v3.30.24', 'chore(master): release 3.30.24 (#1)'],
  ])('skips unrelated tag %s after checking its ancestors', async (badTag, prefix, badMessage, goodTag, goodMessage) => {
    const badSha = prefix.padEnd(40, '0');
    const goodSha = 'd'.repeat(40);
    const pkg = (version: string) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version })).toString('base64') });
    const data: Record<string, unknown> = {
      'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
      'repos/ashlrai/phantom/commits/master': { sha },
      [`repos/ashlrai/phantom/contents/package.json?ref=${sha}`]: pkg(badTag.slice(1)),
      [`repos/ashlrai/phantom/git/ref/tags/${badTag}`]: { ref: `refs/tags/${badTag}`, object: { type: 'commit', sha: badSha } },
      [`repos/ashlrai/phantom/commits/${badSha}`]: { commit: { message: badMessage, committer: { date: '2026-11-09T02:30:00Z' } } },
      [`repos/ashlrai/phantom/commits/${goodSha}`]: { commit: { message: goodMessage, committer: { date: '2026-11-09T01:30:00Z' } } },
      [`repos/ashlrai/phantom/compare/${badSha}...${sha}`]: { status: 'ahead', ahead_by: 1 },
      [`repos/ashlrai/phantom/compare/${goodSha}...${sha}`]: { status: 'ahead', ahead_by: 240 },
      [`repos/ashlrai/phantom/contents/package.json?ref=${badSha}`]: pkg(badTag.slice(1)),
      [`repos/ashlrai/phantom/commits?sha=${badSha}&per_page=30`]: [{ commit: { message: badMessage } }],
      'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: badTag, commit: { sha: badSha } }, { name: goodTag, commit: { sha: goodSha } }],
      'repos/ashlrai/phantom/releases?per_page=100&page=1': [],
      'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [],
      ...greenCi(goodSha),
    };
    const observed = await observeTrain(async (path) => {
      if (Object.hasOwn(data, path)) return data[path];
      if (path.includes('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
      if (path.startsWith('registry/')) return null;
      throw new Error(`unexpected ${path}`);
    }, '2026-11-09T06:00:00Z', 60, { fleet: 'inactive', autorun: 'inactive' });
    expect(observed.head?.tag).toBe(goodTag);
    expect(observed.skippedTags).toEqual([{ tag: badTag, reason: expect.stringContaining(`release_message_mismatch: tag=${badTag}`) }]);
    expect(buildTrain(observed).state.tag).toBe(goodTag);
  });

  // RQ-RELEASE-TRAIN-UNBLOCK-1: v3.30.32 was a hand bump in bridge PR #4735
  // (RQ-UPKEEP-REL). No `chore(<scope>): release 3.30.32` commit exists at or
  // under the tag, so the guard must keep refusing it. Recovery is the next
  // release-please patch, which must not be blocked by the skipped tag.
  const upkeepSubject = 'bridge(RQ-UPKEEP-REL-phantom-20261110): RQ-UPKEEP-REL-phantom-20261110: release 3.30.32 (#4735)';
  const released31 = 'chore(master): release 3.30.31 (#4613)\n\n* chore(release): sync candidate version carriers to 3.30.31\n';

  it('never reads a bridge subject that mentions a release as a release-please commit', () => {
    expect(isReleasePleaseCommit(`${upkeepSubject}\n\nCo-authored-by: x`, '3.30.32')).toBe(false);
    expect(isReleasePleaseCommit('bridge(RQ-UPKEEP-REL-phantom-20261110): chore(master): release 3.30.32', '3.30.32')).toBe(false);
    expect(isReleasePleaseCommit('Revert "chore(master): release 3.30.32 (#1)"', '3.30.32')).toBe(false);
    expect(isReleasePleaseCommit(released31, '3.30.32')).toBe(false);
    expect(isReleasePleaseCommit('chore(master): release 3.30.32 (#4999)', '3.30.32')).toBe(true);
  });

  it('skips the hand-bumped v3.30.32 tag and still enqueues the next release-please PR', async () => {
    const bridge = 'bf68264b99aff8f8ad5728304f118e8a5924aa4d';
    const rp31 = 'da181be3b956e4ba69c4bcf81e625b29c0673cbf';
    const rpHead = '1cb235a8ab23ad920213ef04e716e086a8f0fa8b';
    const pkg = (version: string) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version })).toString('base64') });
    const signed31 = ['phantom-3.30.31.tgz', 'phantom-3.30.31.tgz.sig', 'Phantom.app.tar.gz', 'Phantom.app.tar.gz.sig', 'manifest.json', 'manifest.json.sig', 'latest.json']
      .map((name) => ({ name, created_at: '2026-11-10T09:00:00Z' }));
    const data: Record<string, unknown> = {
      'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
      'repos/ashlrai/phantom/commits/master': { sha },
      [`repos/ashlrai/phantom/contents/package.json?ref=${sha}`]: pkg('3.30.32'),
      'repos/ashlrai/phantom/git/ref/tags/v3.30.32': { ref: 'refs/tags/v3.30.32', object: { type: 'commit', sha: bridge } },
      [`repos/ashlrai/phantom/commits/${bridge}`]: { sha: bridge, commit: { message: `${upkeepSubject}\n\nCo-authored-by: Mason Wyatt <x@users.noreply.github.com>\n`, committer: { date: '2026-11-10T13:12:59Z' } } },
      [`repos/ashlrai/phantom/compare/${bridge}...${sha}`]: { status: 'ahead', ahead_by: 70 },
      [`repos/ashlrai/phantom/contents/package.json?ref=${bridge}`]: pkg('3.30.32'),
      // The ancestor walk sees only bridges and the previous release: nothing to thread.
      [`repos/ashlrai/phantom/commits?sha=${bridge}&per_page=30`]: [
        { commit: { message: upkeepSubject } }, { commit: { message: 'bridge(RQ-RELEASE-ISOLATED-BUILD-1): notes (#4677)' } }, { commit: { message: released31 } },
      ],
      [`repos/ashlrai/phantom/commits/${rp31}`]: { sha: rp31, commit: { message: released31, committer: { date: '2026-11-10T08:00:00Z' } } },
      [`repos/ashlrai/phantom/compare/${rp31}...${sha}`]: { status: 'ahead', ahead_by: 140 },
      'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: 'v3.30.32', commit: { sha: bridge } }, { name: 'v3.30.31', commit: { sha: rp31 } }],
      'repos/ashlrai/phantom/releases?per_page=100&page=1': [
        { id: 32, tag_name: 'v3.30.32', draft: true, name: 'Phantom 3.30.32', body: 'notes', created_at: '2026-11-10T13:40:00Z', assets: [] },
        { id: 31, tag_name: 'v3.30.31', draft: false, name: 'Phantom 3.30.31', body: 'notes', created_at: '2026-11-10T08:10:00Z', assets: signed31 },
      ],
      'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [
        { number: 4760, title: 'chore(master): release 3.30.33', head: { ref: 'release-please--branches--master--components--phantom' } },
      ],
      'repos/ashlrai/phantom/pulls/4760': {
        number: 4760, title: 'chore(master): release 3.30.33', node_id: 'PR_kwDO_test', state: 'open', merged_at: null,
        mergeable: true, mergeable_state: 'clean', head: { ref: 'release-please--branches--master--components--phantom', sha: rpHead },
      },
      [`repos/ashlrai/phantom/commits/${rpHead}/check-runs?filter=latest&app_id=15368&per_page=100&page=1`]: {
        total_count: 1, check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } }],
      },
      'updater/latest.json': { version: '3.30.31' },
      'registry/npm/@ashlr/phantom/3.30.31': { version: '3.30.31', time: '2026-11-10T09:05:00Z' },
      ...greenCi(rp31),
    };
    const observed = await observeTrain(async (path) => {
      if (Object.hasOwn(data, path)) return data[path];
      if (path.includes('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
      throw new Error(`unexpected ${path}`);
    }, '2026-11-11T04:00:00Z', 60, { fleet: 'inactive', autorun: 'inactive' }, async () => ({ queued: false, ejectedAt: null, headCommittedAt: null }));

    // Guard holds: v3.30.32 is skipped with the exact refusal, nothing threads a release message.
    expect(observed.head).toMatchObject({ tag: 'v3.30.31', sha: rp31 });
    expect(observed.head?.releaseMessage).toBeUndefined();
    expect(observed.skippedTags).toEqual([{ tag: 'v3.30.32', reason: `release_message_mismatch: tag=v3.30.32 first_line=${JSON.stringify(upkeepSubject)} expected=chore(<scope>): release 3.30.32` }]);

    // ...and does not block the recovery: the green 3.30.33 release PR is enqueued.
    // The admitted v3.30.31 candidate also earns its tag-ref dependency audit.
    const plan = buildTrain(observed);
    expect(plan.exitCode).toBe(0);
    expect(plan.state).toMatchObject({ stopped: false, tag: 'v3.30.31' });
    expect(plan.writes).toEqual([
      enqueueReleasePullRequest('PR_kwDO_test'),
      { method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/dispatches', body: { ref: 'v3.30.31', inputs: {} } },
    ]);
    expect(plan.state.superseded).toEqual([]);
    const summary = trainStepSummary(plan.state);
    expect(summary).toContain('- release_message_mismatch: tag=v3.30.32');
    expect(summary).toContain('the next release-please tag supersedes their drafts');

    // Once release-please tags 3.30.33, the orphan 3.30.32 draft is superseded, never published.
    const rp33 = 'e'.repeat(40);
    const next = buildTrain(observation({
      masterVersion: '3.30.33',
      tags: [{ name: 'v3.30.33', sha: rp33 }, { name: 'v3.30.32', sha: bridge }, { name: 'v3.30.31', sha: rp31 }],
      head: { tag: 'v3.30.33', sha: rp33, message: 'chore(master): release 3.30.33 (#4760)\n', ancestry: 'identical', committedAt: '2026-11-11T05:00:00Z' },
      releases: [
        { id: 33, tag_name: 'v3.30.33', draft: true, name: 'Phantom 3.30.33', body: 'notes', created_at: '2026-11-11T05:05:00Z', assets: [] },
        { id: 32, tag_name: 'v3.30.32', draft: true, name: 'Phantom 3.30.32', body: 'notes', created_at: '2026-11-10T13:40:00Z', assets: [] },
      ],
    }));
    expect(next.state).toMatchObject({ stopped: false, tag: 'v3.30.33', superseded: ['v3.30.32'] });
    expect(next.writes).toContainEqual({
      method: 'PATCH', path: 'repos/ashlrai/phantom/releases/32',
      body: { name: 'Phantom 3.30.32 (superseded by v3.30.33)', body: 'notes\n\nSuperseded by v3.30.33. This draft stays unpublished.\n', draft: true, prerelease: false },
    });
  });

  it('keeps the step summary to the reason when nothing was skipped', () => {
    expect(trainStepSummary({ reason: 'proceed', skippedTags: [] })).toBe('### Release train\n\nproceed\n');
  });

  it('dispatches attest and npm for the tagged sha and leaves signing to the Mac wrapper', () => {
    const waiting = buildTrain(observation({
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
    }));
    expect(waiting.writes.map((write) => write.path)).toContain('repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/dispatches');
    const attest = waiting.writes.find((write) => write.path.includes('attest-ci-build'));
    expect(attest && attest.method === 'POST' && 'inputs' in attest.body && attest.body.inputs.candidate_sha).toBe(head);
    expect(waiting.state.steps.sign).toMatchObject({ status: 'pending', reason: 'mac-release-autorun' });
    expect(waiting.state.steps.notarize?.reason).toBe('mac-release-autorun');
    const ready = buildTrain(observation({
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
      attest: { runId: 22, attempt: 1, artifactId: 202, completedAt: '2026-11-09T03:10:00.000Z' },
      audit: { runId: 33, attempt: 1 },
      npmPublished: false,
    }));
    const npm = ready.writes.find((write) => write.path.includes('publish-canonical-npm'));
    expect(npm && npm.method === 'POST' && 'ref' in npm.body && npm.body.ref).toBe('master');
    const published = buildTrain(observation({ npmPublished: true, npmAt: '2026-11-09T03:20:00.000Z' }));
    expect(published.writes.some((write) => write.path.includes('publish-canonical-npm'))).toBe(false);
    expect(published.state.stages.npm).toEqual({ at: '2026-11-09T03:20:00.000Z', sinceMergeMs: Date.parse('2026-11-09T03:20:00.000Z') - Date.parse('2026-11-09T02:30:00.000Z') });
    expect(published.state.stages.sign.sinceMergeMs).toBeNull();
    expect(published.state.website).toEqual(WEBSITE_HOOK);
    expect(published.state.steps.website).toMatchObject({ status: 'hooked' });
  });

  it('posts workflow dispatch JSON on stdin with gh api --input -', () => {
    const ci = buildTrain(observation({ masterSha: head })).writes.find((write) => write.path.endsWith('/ci.yml/dispatches'));
    const ciBody = { ref: 'v3.30.27', inputs: { release_gate: 'true' } };
    expect(ci).toEqual({ method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches', body: ciBody });
    expect(releaseGithubCall('POST', 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches', ciBody)).toEqual({
      args: ['api', '--hostname', 'github.com', '--method', 'POST', '--input', '-', 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches'],
      input: '{"ref":"v3.30.27","inputs":{"release_gate":"true"}}',
    });
    const attestBody = {
      ref: 'v3.30.27',
      inputs: { ci_run_id: '11', ci_run_attempt: '2', candidate_sha: head, build_artifact_id: '101' },
    };
    const attest = buildTrain(observation({
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
    })).writes.find((write) => write.path.endsWith('/attest-ci-build.yml/dispatches'));
    expect(attest).toEqual({ method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/dispatches', body: attestBody });
    expect(releaseGithubCall('POST', 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/dispatches', attestBody)).toEqual({
      args: ['api', '--hostname', 'github.com', '--method', 'POST', '--input', '-', 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/dispatches'],
      input: JSON.stringify(attestBody),
    });
    const npmBody = {
      ref: 'master',
      inputs: {
        candidate_sha: head, ci_run_id: '11', ci_run_attempt: '2',
        attestor_run_id: '22', attestor_run_attempt: '1', attested_artifact_id: '202', version: '3.30.27',
        audit_run_id: '33', audit_run_attempt: '1',
      },
    };
    const npm = buildTrain(observation({
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
      attest: { runId: 22, attempt: 1, artifactId: 202, completedAt: '2026-11-09T03:10:00.000Z' },
      audit: { runId: 33, attempt: 1 },
      npmPublished: false,
    })).writes.find((write) => write.path.endsWith('/publish-canonical-npm.yml/dispatches'));
    expect(npm).toEqual({ method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/publish-canonical-npm.yml/dispatches', body: npmBody });
    expect(releaseGithubCall('POST', 'repos/ashlrai/phantom/actions/workflows/publish-canonical-npm.yml/dispatches', npmBody).input).toBe(JSON.stringify(npmBody));
    expect(releaseGithubCall('GET', 'repos/ashlrai/phantom')).toEqual({
      args: ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom'],
    });
    for (const body of [ciBody, attestBody, npmBody]) expect(JSON.stringify(body)).not.toContain('null');
  });

  it('sends workflow dispatches with GITHUB_TOKEN, not the App token', () => {
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches')).toBe(false);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/dispatches')).toBe(false);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/dispatches')).toBe(false);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/publish-canonical-npm.yml/dispatches')).toBe(false);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/release-please.yml/dispatches')).toBe(false);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/finalize-github-release.yml/dispatches')).toBe(false);
    expect(releaseWriteUsesAppToken('PATCH', 'repos/ashlrai/phantom/releases/1')).toBe(true);
    expect(releaseWriteUsesAppToken('POST', 'graphql')).toBe(true);
    expect(releaseWriteUsesAppToken('GET', 'repos/ashlrai/phantom/commits/master')).toBe(false);
  });

  it('dispatches finalize for a stocked draft and never edits v3.30.34', () => {
    const integrity = 'sha512-Z9STmExvd1DbX+gD466UJ2pxrpTAJ5KioHOtO2r5UlOPOFrAgqoM92gjl6hugOQmoX2N9KaFU9sY38OAA76bBA==';
    const assets = [
      'ashlr-phantom-3.30.27.tgz', 'ashlr-phantom-3.30.27.tgz.sig',
      'Phantom_3.30.27_aarch64.app.tar.gz', 'Phantom_3.30.27_aarch64.app.tar.gz.sig',
      'manifest.json', 'manifest.json.sig', 'latest.json',
    ].map((name) => ({ name, created_at: '2026-11-09T03:30:00.000Z' }));
    const newer = 'chore(master): release 3.30.35 (#10)\n\n* chore(release): sync candidate version carriers to 3.30.35\n';
    const held = buildTrain(observation({
      masterVersion: '3.30.35',
      tags: [{ name: 'v3.30.35', sha: head }],
      head: { tag: 'v3.30.35', sha: head, message: newer, ancestry: 'ancestor', committedAt: '2026-11-09T02:30:00.000Z' },
      releases: [
        { id: 10, tag_name: 'v3.30.35', draft: true, name: 'Phantom 3.30.35', body: 'notes', created_at: '2026-11-11T00:00:00Z', assets: [] },
        { id: 9, tag_name: 'v3.30.34', draft: true, name: 'Phantom 3.30.34', body: 'held', created_at: '2026-11-10T00:00:00Z', assets: [] },
      ],
    }));
    expect(held.writes.some((write) => write.path.endsWith('/releases/9'))).toBe(false);
    const ready = buildTrain(observation({
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
      attest: { runId: 22, attempt: 1, artifactId: 202, completedAt: '2026-11-09T03:10:00.000Z' },
      audit: { runId: 33, attempt: 1 },
      npmPublished: true,
      npmPublish: { runId: 44, attempt: 1, integrity },
      releases: [{ id: 3, tag_name: 'v3.30.27', draft: true, name: 'Phantom 3.30.27', body: 'notes', created_at: '2026-11-09T02:36:49Z', assets }],
    }));
    const finalize = ready.writes.find((write) => write.path.endsWith('/finalize-github-release.yml/dispatches'));
    expect(finalize).toEqual({
      method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/finalize-github-release.yml/dispatches',
      body: { ref: 'master', inputs: {
        version: '3.30.27', publish_run_id: '44', publish_run_attempt: '1', candidate_sha: head,
        candidate_integrity: integrity, confirm_stable_finalization: 'true',
      } },
    });
    expect(releaseWriteUsesAppToken('POST', finalize!.path)).toBe(false);
    const waiting = buildTrain(observation({
      npmPublished: true, npmPublish: { runId: 44, attempt: 1, integrity }, finalizePending: true,
      releases: [{ id: 3, tag_name: 'v3.30.27', draft: true, name: 'Phantom 3.30.27', body: 'notes', created_at: '2026-11-09T02:36:49Z', assets }],
    }));
    expect(waiting.writes.some((write) => write.path.includes('finalize-github-release'))).toBe(false);
    const superseded = 'chore(master): release 3.30.34 (#9)\n\n* chore(release): sync candidate version carriers to 3.30.34\n';
    const blocked = buildTrain(observation({
      masterVersion: '3.30.34',
      tags: [{ name: 'v3.30.34', sha: head }],
      head: { tag: 'v3.30.34', sha: head, message: superseded, ancestry: 'ancestor', committedAt: '2026-11-09T02:30:00.000Z' },
      npmPublished: true, npmPublish: { runId: 44, attempt: 1, integrity },
      releases: [{ id: 9, tag_name: 'v3.30.34', draft: true, name: 'Phantom 3.30.34', body: 'held', created_at: '2026-11-10T00:00:00Z', assets }],
    }));
    expect(blocked.writes.some((write) => write.path.includes('finalize-github-release'))).toBe(false);
    const payload = Buffer.from(JSON.stringify({
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { path: '.github/workflows/publish-canonical-npm.yml' } },
          internalParameters: { github: { event_name: 'workflow_dispatch' } },
        },
        runDetails: { metadata: { invocationId: 'https://github.com/ashlrai/phantom/actions/runs/44/attempts/1' } },
      },
    })).toString('base64');
    expect(publishRunFromAttestation({ attestations: [{ bundle: { dsseEnvelope: { payload } } }] })).toEqual({ runId: 44, attempt: 1 });
    expect(publishRunFromAttestation({ attestations: [] })).toBeNull();
    const split = Buffer.from(JSON.stringify({
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { path: '.github/workflows/publish-canonical-npm.yml' } },
          internalParameters: { github: { event_name: 'workflow_dispatch' } },
        },
      },
      elsewhere: { runDetails: { metadata: { invocationId: 'https://github.com/ashlrai/phantom/actions/runs/44/attempts/1' } } },
    })).toString('base64');
    expect(publishRunFromAttestation({ attestations: [{ bundle: { dsseEnvelope: { payload: split } } }] })).toBeNull();
    const wrong = Buffer.from(JSON.stringify({
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { path: '.github/workflows/ci.yml' } },
          internalParameters: { github: { event_name: 'workflow_dispatch' } },
        },
        runDetails: { metadata: { invocationId: 'https://github.com/ashlrai/phantom/actions/runs/44/attempts/1' } },
      },
    })).toString('base64');
    expect(publishRunFromAttestation({ attestations: [{ bundle: { dsseEnvelope: { payload: wrong } } }] })).toBeNull();
  });

  it('caps finalize retries for one version and sha', () => {
    const integrity = 'sha512-Z9STmExvd1DbX+gD466UJ2pxrpTAJ5KioHOtO2r5UlOPOFrAgqoM92gjl6hugOQmoX2N9KaFU9sY38OAA76bBA==';
    const assets = [
      'ashlr-phantom-3.30.27.tgz', 'ashlr-phantom-3.30.27.tgz.sig',
      'Phantom_3.30.27_aarch64.app.tar.gz', 'Phantom_3.30.27_aarch64.app.tar.gz.sig',
      'manifest.json', 'manifest.json.sig', 'latest.json',
    ].map((name) => ({ name, created_at: '2026-11-09T03:30:00.000Z' }));
    const base = {
      build: { runId: 11, attempt: 2, artifactId: 101, completedAt: '2026-11-09T03:00:00.000Z' },
      attest: { runId: 22, attempt: 1, artifactId: 202, completedAt: '2026-11-09T03:10:00.000Z' },
      audit: { runId: 33, attempt: 1 },
      npmPublished: true as const,
      npmPublish: { runId: 44, attempt: 1, integrity },
      releases: [{ id: 3, tag_name: 'v3.30.27', draft: true, name: 'Phantom 3.30.27', body: 'notes', created_at: '2026-11-09T02:36:49Z', assets }],
    };
    const dispatched = (runs: TrainObservation['finalizeRuns']) => buildTrain(observation({ ...base, finalizeRuns: runs }))
      .writes.some((write) => write.path.endsWith('/finalize-github-release.yml/dispatches'));
    expect(dispatched([])).toBe(true);
    const recent = { status: 'completed', conclusion: 'failure', createdAt: '2026-11-09T05:30:00.000Z', version: '3.30.27', sha: head };
    expect(dispatched([recent])).toBe(false);
    expect(finalizeRetryDecision({
      now: '2026-11-09T06:00:00.000Z', version: '3.30.27', sha: head, since: '2026-11-09T02:30:00.000Z',
      runs: [{ ...recent, createdAt: '2026-11-09T04:00:00.000Z' }],
    }).dispatch).toBe(true);
    expect(dispatched([
      { status: 'completed', conclusion: 'failure', createdAt: '2026-11-09T03:00:00.000Z', version: '3.30.27', sha: head },
      { status: 'completed', conclusion: 'failure', createdAt: '2026-11-09T04:30:00.000Z', version: '3.30.27', sha: head },
    ])).toBe(false);
    expect(dispatched([
      { status: 'completed', conclusion: 'failure', createdAt: '2026-11-09T05:30:00.000Z', version: null, sha: null },
    ])).toBe(false);
    expect(dispatched([
      { status: 'completed', conclusion: 'failure', createdAt: '2026-11-09T01:00:00.000Z', version: null, sha: null },
      { status: 'completed', conclusion: 'failure', createdAt: '2026-11-09T05:30:00.000Z', version: '9.9.9', sha: 'c'.repeat(40) },
    ])).toBe(true);
    const titled = `finalize 3.30.27 ${head}`;
    expect(finalizeRunIdentity(titled)).toEqual({ version: '3.30.27', sha: head });
    expect(finalizeRunIdentity('Finalize GitHub stable release')).toBeNull();
    expect(readFileSync(new URL('../.github/workflows/finalize-github-release.yml', import.meta.url), 'utf8'))
      .toContain('run-name: finalize ${{ inputs.version }} ${{ inputs.candidate_sha }}');
    const other = (createdAt: string) => ({ status: 'completed', conclusion: 'failure', createdAt, version: '3.30.36', sha: head });
    expect(dispatched([
      other('2026-11-09T03:00:00.000Z'),
      other('2026-11-09T04:30:00.000Z'),
    ])).toBe(true);
  });

  it('reads every finalize run in the last day so another version cannot hide the cap', async () => {
    const now = '2026-11-09T06:00:00.000Z';
    const since = '2026-11-08T06:00:00.000Z';
    expect(finalizeRunsQuery(now, 1)).toContain(`created=${encodeURIComponent(`>=${since}`)}`);
    expect(finalizeRunsQuery(now, 1)).toContain('per_page=100&page=1');
    const noise = Array.from({ length: 100 }, (_, index) => ({
      display_title: `finalize 3.30.36 ${'c'.repeat(40)}`,
      status: 'completed', conclusion: 'failure', created_at: '2026-11-09T04:00:00.000Z', id: index,
    }));
    const buried = [
      { display_title: `finalize 3.30.27 ${head}`, status: 'completed', conclusion: 'failure', created_at: '2026-11-09T03:00:00.000Z' },
      { display_title: `finalize 3.30.27 ${head}`, status: 'completed', conclusion: 'failure', created_at: '2026-11-09T04:30:00.000Z' },
    ];
    const runs = await listFinalizeRuns(async (path) => {
      if (path === finalizeRunsQuery(now, 1)) return { total_count: 102, workflow_runs: noise };
      if (path === finalizeRunsQuery(now, 2)) return { total_count: 102, workflow_runs: buried };
      throw new Error(`unexpected ${path}`);
    }, now);
    expect(runs.filter((run) => run.version === '3.30.27')).toHaveLength(2);
    expect(finalizeRetryDecision({ now, version: '3.30.27', sha: head, since: '2026-11-09T02:30:00.000Z', runs }).dispatch).toBe(false);
    expect(finalizeRetryDecision({ now, version: '3.30.36', sha: 'c'.repeat(40), since: '2026-11-09T02:30:00.000Z', runs }).reason).toBe('finalize-attempt-cap');
    await expect(listFinalizeRuns(async (path) => {
      const page = Number(new URL(`https://example.test/?${path.split('?')[1] ?? ''}`).searchParams.get('page'));
      if (page >= 1 && page <= 10) return { total_count: 1000, workflow_runs: noise };
      throw new Error(`unexpected ${path}`);
    }, now)).rejects.toThrow(/incomplete finalize run inventory/);
  });

  it('rejects writes outside the sanctioned release paths', () => {
    const bad = { method: 'POST', path: 'repos/ashlrai/phantom/git/refs', body: { sha: head, merge_method: 'merge' } } as ReleaseWrite;
    expect(() => assertReleaseWrite(bad)).toThrow(/refusing/);
    expect(() => assertReleaseWrite({ method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/release-please.yml/dispatches', body: { ref: 'v3.30.28', inputs: {} } })).toThrow(/refusing/);
    const publish = { method: 'PATCH', path: 'repos/ashlrai/phantom/releases/2', body: { name: 'x', body: 'y', draft: false, prerelease: false } } as unknown as ReleaseWrite;
    expect(() => assertReleaseWrite(publish)).toThrow(/publish/);
    const plan = buildTrain(observation());
    for (const write of plan.writes) expect(() => assertReleaseWrite(write)).not.toThrow();
    expect(markWritesApplied(plan.state).steps.supersede?.status).toBe('complete');
  });

  it('selects the highest feed semver and fails a publish whose feed is older', () => {
    const entries = [
      { version: '3.29.3', cached: true },
      { version: '3.30.24' },
      { version: '3.30.28' },
    ];
    expect(selectUpdaterFeed(entries)).toBe('3.30.28');
    expect(selectUpdaterFeed([...entries].reverse())).toBe('3.30.28');
    expect(selectUpdaterFeed([{ version: '3.29.3' }, { version: '3.30.24', cached: true }])).toBe('3.30.24');
    expect(updaterFeedMatches('3.30.28', '3.29.3')).toBe(false);
    const published = observation({
      masterVersion: '3.30.28',
      tags: [{ name: 'v3.30.28', sha: head }],
      head: { tag: 'v3.30.28', sha: head, message: message.replaceAll('3.30.27', '3.30.28'), ancestry: 'identical', committedAt: '2026-11-09T02:30:00.000Z' },
      releases: [{ id: 9, tag_name: 'v3.30.28', draft: false, name: 'Phantom 3.30.28', body: 'notes', created_at: '2026-11-09T03:00:00Z', assets: [{ name: 'latest.json', created_at: '2026-11-09T03:00:00Z' }] }],
      npmPublished: true,
      feedVersion: '3.29.3',
    });
    expect(buildTrain(published)).toMatchObject({ exitCode: 1, writes: [], state: { reason: 'feed-version-mismatch', version: '3.30.28' } });
    expect(buildTrain({ ...published, feedVersion: '3.30.28' }).exitCode).toBe(0);
  });

  it('reads a release-state file from phm release status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-status-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    const plan = buildTrain(observation());
    writeFileSync(file, JSON.stringify(plan.state));
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await cmdRelease(['status', '--file', file, '--json'])).toBe(0);
    } finally { process.stdout.write = write; }
    const parsed = JSON.parse(lines.join('')) as { ok: boolean; schema: string; state: { schema: string } };
    expect(parsed).toMatchObject({ ok: true, schema: TRAIN_SCHEMA, state: { schema: TRAIN_SCHEMA, tag: 'v3.30.27' } });
    expect(await cmdRelease(['status', '--json'])).toBe(0);
    expect(await cmdRelease(['nope'])).toBe(2);
  });

  it('observes the newest tag and an unpublished registry row', async () => {
    const data: Record<string, unknown> = {
      'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
      [`repos/ashlrai/phantom/commits/${sha}`]: { sha, commit: { message: 'merge', committer: { date: '2026-11-09T01:00:00Z' } } },
      'repos/ashlrai/phantom/commits/master': { sha },
      [`repos/ashlrai/phantom/contents/package.json?ref=${sha}`]: { encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version: '3.30.27' })).toString('base64') },
      'repos/ashlrai/phantom/git/ref/tags/v3.30.27': { ref: 'refs/tags/v3.30.27', object: { type: 'commit', sha: head } },
      [`repos/ashlrai/phantom/commits/${head}`]: { sha: head, commit: { message, committer: { date: '2026-11-09T02:30:00.000Z' } } },
      [`repos/ashlrai/phantom/compare/${head}...${sha}`]: { status: 'ahead', ahead_by: 2 },
      'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: 'v3.30.27', commit: { sha: head } }],
      'repos/ashlrai/phantom/releases?per_page=100&page=1': [{ id: 3, tag_name: 'v3.30.27', draft: true, name: 'Phantom 3.30.27', body: '', created_at: '2026-11-09T02:36:49Z', assets: [] }],
      'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [],
      [`repos/ashlrai/phantom/actions/workflows/ci.yml/runs?head_sha=${head}&per_page=20`]: { total_count: 0, workflow_runs: [] },
      [`repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/runs?head_sha=${head}&per_page=10`]: { total_count: 0, workflow_runs: [] },
      'registry/npm/@ashlr/phantom/3.30.27': null,
      ...greenCi(head),
    };
    const observed = await observeTrain(async (path) => {
      if (!Object.hasOwn(data, path)) throw new Error(`unexpected ${path}`);
      return data[path];
    }, '2026-11-09T06:00:00.000Z', 30, { fleet: 'inactive', autorun: 'inactive' });
    expect(observed.cadenceMinutes).toBe(30);
    expect(observed.head?.ancestry).toBe('ancestor');
    expect(observed.candidateCi).toBe('green');
    expect(observed.npmPublished).toBe(false);
    expect(buildTrain(observed).state.tag).toBe('v3.30.27');
    const incomplete = { ...greenCi(head) };
    const checks = `repos/ashlrai/phantom/commits/${head}/check-runs?filter=latest&app_id=15368&per_page=100&page=1`;
    incomplete[checks] = { total_count: 2, check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } }] };
    const unpaged = await observeTrain(async (path) => {
      if (Object.hasOwn(incomplete, path)) return incomplete[path];
      if (!Object.hasOwn(data, path)) throw new Error(`unexpected ${path}`);
      return data[path];
    }, '2026-11-09T06:00:00.000Z', 30, { fleet: 'inactive', autorun: 'inactive' });
    expect(unpaged.candidateCi).toBe('unknown');
    expect(buildTrain(unpaged).writes.some((write) => write.path.endsWith('/ci.yml/dispatches'))).toBe(false);
  });

  it('gates release PR readiness on required checks only and observes queue state', async () => {
    const pullSha = 'c'.repeat(40);
    const pkg = { encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version: '3.30.27' })).toString('base64') };
    const data: Record<string, unknown> = {
      'repos/ashlrai/phantom': { id: 1263526319, full_name: 'ashlrai/phantom' },
      [`repos/ashlrai/phantom/commits/${sha}`]: { sha, commit: { message: 'merge', committer: { date: '2026-11-09T01:00:00Z' } } },
      'repos/ashlrai/phantom/commits/master': { sha },
      [`repos/ashlrai/phantom/contents/package.json?ref=${sha}`]: pkg,
      'repos/ashlrai/phantom/git/ref/tags/v3.30.27': { ref: 'refs/tags/v3.30.27', object: { type: 'commit', sha: head } },
      [`repos/ashlrai/phantom/commits/${head}`]: { sha: head, commit: { message, committer: { date: '2026-11-09T02:30:00.000Z' } } },
      [`repos/ashlrai/phantom/compare/${head}...${sha}`]: { status: 'ahead', ahead_by: 2 },
      'repos/ashlrai/phantom/tags?per_page=100&page=1': [{ name: 'v3.30.27', commit: { sha: head } }],
      'repos/ashlrai/phantom/releases?per_page=100&page=1': [],
      'repos/ashlrai/phantom/pulls?state=open&per_page=100&page=1': [{ number: 9, title: 'chore(master): release 3.30.28', head: { ref: 'release-please--master' } }],
      'repos/ashlrai/phantom/pulls/9': {
        number: 9, title: 'chore(master): release 3.30.28', state: 'open', merged_at: null,
        node_id: 'PR_kwDO_test', mergeable: true, mergeable_state: 'clean',
        head: { ref: 'release-please--master', sha: pullSha },
      },
      'registry/npm/@ashlr/phantom/3.30.27': null,
      ...greenCi(head),
    };
    const pullRunsPath = `repos/ashlrai/phantom/commits/${pullSha}/check-runs?filter=latest&app_id=15368&per_page=100&page=1`;
    const pullComparePath = `repos/ashlrai/phantom/compare/${sha}...${pullSha}`;
    const observe = (checkRuns: Record<string, unknown>[], queued = false, mergeableState = 'clean', mergeable: boolean | null = true, ejectedAt: string | null = null, headCommittedAt: string | null = null, pullCompareStatus = 'diverged') => observeTrain(async (path) => {
      if (path === pullRunsPath) return { total_count: checkRuns.length, check_runs: checkRuns };
      if (path === pullComparePath) return { status: pullCompareStatus };
      if (path === 'repos/ashlrai/phantom/pulls/9') {
        return { ...(data[path] as Record<string, unknown>), mergeable, mergeable_state: mergeableState };
      }
      if (path.includes('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
      if (!Object.hasOwn(data, path)) throw new Error(`unexpected ${path}`);
      return data[path];
    }, '2026-11-09T06:00:00.000Z', 30, { fleet: 'inactive', autorun: 'inactive' }, async () => ({ queued, ejectedAt, headCommittedAt }));
    const actions = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, app: { id: 15368 } });
    // Required Merge Gate green: advisory skipped or failed runs never gate the enqueue.
    const green = observe([actions('Merge Gate', 'completed', 'success'), actions('Docs PR', 'completed', 'skipped'), actions('Mac exhaustive', 'completed', 'skipped')]);
    await expect(green).resolves.toMatchObject({ openReleasePr: { number: 9, queued: false, mergeable: 'MERGEABLE' }, pullChecks: { pending: 0, failing: 0 } });
    const advisoryFail = observe([actions('Merge Gate', 'completed', 'success'), actions('Dependency audit', 'completed', 'failure')]);
    await expect(advisoryFail).resolves.toMatchObject({ pullChecks: { pending: 0, failing: 0 } });
    // The required context still gates: pending waits, red refuses, absent waits.
    const pending = observe([actions('Merge Gate', 'in_progress', null), actions('Docs PR', 'completed', 'skipped')]);
    await expect(pending).resolves.toMatchObject({ pullChecks: { pending: 1, failing: 0 } });
    const failing = observe([actions('Merge Gate', 'completed', 'failure'), actions('Docs PR', 'completed', 'skipped')]);
    await expect(failing).resolves.toMatchObject({ pullChecks: { pending: 0, failing: 1 } });
    const absent = observe([actions('Dependency audit', 'completed', 'failure')]);
    await expect(absent).resolves.toMatchObject({ pullChecks: { pending: 1, failing: 0 } });
    // mergeable_state folds in advisory state; only the conflict signal decides.
    const unstable = observe([actions('Merge Gate', 'completed', 'success')], false, 'unstable');
    await expect(unstable).resolves.toMatchObject({ openReleasePr: { mergeable: 'MERGEABLE' } });
    const conflicting = observe([actions('Merge Gate', 'completed', 'success')], false, 'dirty', false);
    await expect(conflicting).resolves.toMatchObject({ openReleasePr: { mergeable: 'CONFLICTING' } });
    const unknownMergeable = observe([actions('Merge Gate', 'completed', 'success')], false, 'clean', null);
    await expect(unknownMergeable).resolves.toMatchObject({ openReleasePr: { mergeable: 'UNKNOWN' } });
    // An already-queued PR is observed and plans no duplicate enqueue.
    const queued = await observe([actions('Merge Gate', 'completed', 'success')], true);
    expect(queued.openReleasePr?.queued).toBe(true);
    const queuedPlan = buildTrain(queued);
    expect(queuedPlan.writes.filter((write) => write.path === 'graphql')).toEqual([]);
    const unqueuedPlan = buildTrain(await observe([actions('Merge Gate', 'completed', 'success')]));
    expect(unqueuedPlan.writes.filter((write) => write.path === 'graphql')).toHaveLength(1);

    // A merge-queue ejection that postdates the head commit marks the green
    // head checks stale: the plan syncs the branch instead of re-enqueueing.
    const greenRuns = [actions('Merge Gate', 'completed', 'success')];
    const ejected = await observe(greenRuns, false, 'clean', true, '2026-11-09T05:00:00.000Z', '2026-11-09T04:00:00.000Z');
    expect(ejected.openReleasePr).toMatchObject({ queued: false, queueEjectedAt: '2026-11-09T05:00:00.000Z', headCommittedAt: '2026-11-09T04:00:00.000Z', branchSyncDue: true });
    const syncPlan = buildTrain(ejected);
    const syncWrites = syncPlan.writes.filter((write) => write.path === 'graphql');
    expect(syncWrites).toEqual([syncReleasePullRequest('PR_kwDO_test', pullSha)]);
    // A head committed after the ejection already carries fresh evidence, a
    // head that contains master has nothing to merge, and a missing timestamp
    // fails closed to the ordinary enqueue.
    const addressed = await observe(greenRuns, false, 'clean', true, '2026-11-09T04:00:00.000Z', '2026-11-09T05:00:00.000Z');
    expect(addressed.openReleasePr?.branchSyncDue).toBe(false);
    expect(buildTrain(addressed).writes.filter((write) => write.path === 'graphql')[0]?.body.query).toBe(ENQUEUE_PULL_REQUEST);
    const contained = await observe(greenRuns, false, 'clean', true, '2026-11-09T05:00:00.000Z', '2026-11-09T04:00:00.000Z', 'ahead');
    expect(contained.openReleasePr?.branchSyncDue).toBe(false);
    const undated = await observe(greenRuns, false, 'clean', true, '2026-11-09T05:00:00.000Z', null);
    expect(undated.openReleasePr?.branchSyncDue).toBe(false);
  });

  it('reads merge-queue membership, ejection and head commit from GraphQL and fails closed', async () => {
    const nodeId = 'PR_kwDO_test';
    const removal = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-09T05:00:00.000Z' };
    const addition = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-09T04:30:00.000Z' };
    // The membership read and the ejection detail read are separate queries;
    // the mock answers each by the query text it carries.
    const call = (queued: unknown, detail: unknown) => (_method: string, _path: string, body?: unknown) => {
      const query = String((body as { query?: string } | undefined)?.query ?? '');
      if (query.includes('isInMergeQueue')) return JSON.stringify(queued);
      if (query.includes('timelineItems')) return JSON.stringify(detail);
      throw new Error(`unexpected query ${query}`);
    };
    const membership = (isInMergeQueue: unknown) => ({ data: { node: { isInMergeQueue } } });
    const detail = (nodes: unknown[], committedDate: unknown = '2026-11-09T04:00:00.000Z') => ({
      data: { node: { headRef: { target: { committedDate } }, timelineItems: { nodes } } },
    });
    // Not queued and the newest queue event is a removal: the ejection time is exposed.
    await expect(releasePrMergeQueueState(nodeId, call(membership(false), detail([addition, removal]))))
      .resolves.toEqual({ queued: false, ejectedAt: '2026-11-09T05:00:00.000Z', headCommittedAt: '2026-11-09T04:00:00.000Z' });
    // Queued wins over a trailing removal and skips the detail read entirely.
    await expect(releasePrMergeQueueState(nodeId, call(membership(true), { data: null, errors: [{ message: 'must not be read' }] })))
      .resolves.toEqual({ queued: true, ejectedAt: null, headCommittedAt: null });
    // A newest addition is never an ejection; a missing head commit stays null.
    await expect(releasePrMergeQueueState(nodeId, call(membership(false), detail([removal, addition]))))
      .resolves.toMatchObject({ queued: false, ejectedAt: null });
    await expect(releasePrMergeQueueState(nodeId, call(membership(false), detail([], null))))
      .resolves.toMatchObject({ headCommittedAt: null });
    // A failed detail read degrades to ordinary enqueue evidence, never a throw.
    await expect(releasePrMergeQueueState(nodeId, call(membership(false), { data: null, errors: [{ message: 'no' }] })))
      .resolves.toEqual({ queued: false, ejectedAt: null, headCommittedAt: null });
    const badJson = () => 'not-json';
    await expect(releasePrMergeQueueState(nodeId, badJson)).rejects.toThrow();
    // Membership failures still fail closed.
    await expect(releasePrMergeQueueState(nodeId, call({ data: { node: null } }, detail([])))).rejects.toThrow('release queue state unavailable');
    await expect(releasePrMergeQueueState(nodeId, call({ data: null, errors: [{ message: 'no' }] }, detail([])))).rejects.toThrow('release queue state unavailable');
    await expect(releasePrMergeQueueState(nodeId, call(membership('yes'), detail([])))).rejects.toThrow('release queue state unavailable');
    await expect(releasePrMergeQueueState('not-a-node', call(membership(false), detail([])))).rejects.toThrow('invalid release pull request');
  });

  it('guards the head-pinned release branch sync write', () => {
    const write = syncReleasePullRequest('PR_kwDO_test', pr);
    expect(write).toEqual({
      method: 'POST', path: 'graphql',
      body: { query: UPDATE_PULL_REQUEST_BRANCH, variables: { pullRequestId: 'PR_kwDO_test', expectedHeadOid: pr } },
    });
    expect(() => assertReleaseWrite(write)).not.toThrow();
    expect(() => syncReleasePullRequest('not-a-node', pr)).toThrow('refusing release branch sync');
    expect(() => syncReleasePullRequest('PR_kwDO_test', 'not-a-sha')).toThrow('refusing release branch sync');
    // The guard refuses a sync mutation without a pinned head and any other GraphQL write.
    expect(() => assertReleaseWrite({ method: 'POST', path: 'graphql', body: { query: UPDATE_PULL_REQUEST_BRANCH, variables: { pullRequestId: 'PR_kwDO_test' } } })).toThrow('refusing release branch sync');
    expect(() => assertReleaseWrite({ method: 'POST', path: 'graphql', body: { query: UPDATE_PULL_REQUEST_BRANCH, variables: { pullRequestId: 'PR_kwDO_test', expectedHeadOid: 'bad' } } })).toThrow('refusing release branch sync');
    expect(() => assertReleaseWrite({ method: 'POST', path: 'graphql', body: { query: 'mutation{mergePullRequest{clientMutationId}}', variables: { pullRequestId: 'PR_kwDO_test' } } })).toThrow('refusing release write');
    expect(() => assertReleaseWrite({ method: 'POST', path: 'graphql', body: { query: ENQUEUE_PULL_REQUEST, variables: { pullRequestId: 'PR_kwDO_test', expectedHeadOid: pr } } })).toThrow('refusing release enqueue');
  });
  it('maps only a 404 on the exact version tag ref to not-tagged', () => {
    // Train runs 43861440856 and 43861554608 failed with "github GET repos/ashlrai/phantom/git/ref/tags/v3.30.35 failed"
    // right after release PR #6291 merged, before the tag existed.
    expect(isMissingTagRef('repos/ashlrai/phantom/git/ref/tags/v3.30.35', 'gh: Not Found (HTTP 404)')).toBe(true);
    expect(isMissingTagRef('repos/ashlrai/phantom/git/ref/tags/v3.30.35', 'gh: Server Error (HTTP 500)')).toBe(false);
    expect(isMissingTagRef('repos/ashlrai/phantom/git/ref/tags/v3.30.35', undefined)).toBe(false);
    expect(isMissingTagRef('repos/ashlrai/phantom/commits/master', 'gh: Not Found (HTTP 404)')).toBe(false);
    expect(isMissingTagRef('repos/ashlrai/other/git/ref/tags/v3.30.35', 'gh: Not Found (HTTP 404)')).toBe(false);
    expect(isMissingTagRef('repos/ashlrai/phantom/git/ref/tags/v3.30.35-rc', 'gh: Not Found (HTTP 404)')).toBe(false);
  });
});
