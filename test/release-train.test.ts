import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import {
  admitCiRun, allowReleasePrDispatch, assertReleaseWrite, buildTrain, cappedCadenceMinutes, docsCarriersSynced, ENQUEUE_PULL_REQUEST,
  judgeRequiredChecks, releaseHeadBranch, releaseWriteUsesAppToken, TRAIN_JOB_CHECK_NAME,
  enqueueReleasePullRequest, hostedTrainGate, isReleasePleaseCommit,
  successorTagConflict, refusePublishIfSuccessorConflict,
  markWritesApplied, mergeStageDone, observeTrain, pauseReleaseTrain, readSentinel, releaseGithubCall, releaseKillDecision, selectUpdaterFeed,
  TRAIN_SCHEMA, updaterFeedMatches, WEBSITE_HOOK,
  type ReleaseWrite, type TrainObservation,
} from '../src/core/release/train.js';

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

  it('sends workflow dispatches with the App token, not GITHUB_TOKEN', () => {
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches')).toBe(true);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/dispatches')).toBe(true);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/publish-canonical-npm.yml/dispatches')).toBe(true);
    expect(releaseWriteUsesAppToken('POST', 'repos/ashlrai/phantom/actions/workflows/release-please.yml/dispatches')).toBe(true);
    expect(releaseWriteUsesAppToken('PATCH', 'repos/ashlrai/phantom/releases/1')).toBe(true);
    expect(releaseWriteUsesAppToken('GET', 'repos/ashlrai/phantom/commits/master')).toBe(false);
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
      [`repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/runs?head_sha=${head}&status=success&per_page=5`]: { total_count: 0, workflow_runs: [] },
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
});
