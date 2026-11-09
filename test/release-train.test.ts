import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import {
  admitCiRun, assertReleaseWrite, buildTrain, cappedCadenceMinutes, docsCarriersSynced, ENQUEUE_PULL_REQUEST,
  enqueueReleasePullRequest, failedBuildWithin, hostedTrainGate, isReleasePleaseCommit,
  markWritesApplied, mergeStageDone, observeTrain, pauseReleaseTrain, readSentinel, releaseGithubCall, releaseKillDecision, selectUpdaterFeed,
  TRAIN_SCHEMA, updaterFeedMatches, WEBSITE_HOOK,
  type ReleaseWrite, type TrainObservation,
} from '../src/core/release/train.js';

const sha = 'a'.repeat(40);
const head = 'b'.repeat(40);
const pr = 'c'.repeat(40);
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
    build: null,
    buildPending: false,
    buildCooldown: false,
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

  it('admits only sanctioned ci runs and backs off after a recent failure', () => {
    const repo = { full_name: 'ashlrai/phantom' };
    const good = { head_sha: head, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', repository: repo, head_repository: repo, head_branch: 'v3.30.28' };
    expect(admitCiRun(good, head, 'v3.30.28')).toBe(true);
    expect(admitCiRun({ ...good, event: 'push' }, head, 'v3.30.28')).toBe(false);
    expect(admitCiRun({ ...good, path: '.github/workflows/other.yml' }, head, 'v3.30.28')).toBe(false);
    expect(admitCiRun({ ...good, repository: { full_name: 'other/phantom' } }, head, 'v3.30.28')).toBe(false);
    const now = Date.parse('2026-11-09T06:00:00Z');
    expect(failedBuildWithin({ status: 'completed', conclusion: 'failure', updated_at: '2026-11-09T01:00:00Z' }, now)).toBe(true);
    expect(failedBuildWithin({ status: 'completed', conclusion: 'failure', updated_at: '2026-11-08T20:00:00Z' }, now)).toBe(false);
    expect(buildTrain(observation({ buildCooldown: true })).writes.some((write) => write.path.includes('/ci.yml/'))).toBe(false);
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

  it('caps the cadence at hourly and only cuts a green release-please pull request', () => {
    expect(cappedCadenceMinutes(30)).toBe(60);
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
    const subject = buildTrain(observation({ head: { tag: 'v3.30.27', sha: head, message: 'feat: private commit text\n', ancestry: 'ancestor', committedAt: null } }));
    expect(subject).toMatchObject({ exitCode: 1, writes: [], state: { reason: 'candidate-refused', refusal: {
      check: 'release-please-subject', candidateSha: head, observed: false, required: true,
    } } });
    expect(JSON.stringify(subject.state.refusal)).not.toContain('private commit text');
    const ancestry = buildTrain(observation({ head: { tag: 'v3.30.27', sha: head, message, ancestry: 'diverged', committedAt: null } }));
    expect(ancestry.state.refusal).toEqual({ check: 'candidate-ancestry', candidateSha: head, observed: 'diverged', required: 'ancestor or identical' });
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
    const ci = buildTrain(observation()).writes.find((write) => write.path.endsWith('/ci.yml/dispatches'));
    const ciBody = { ref: 'v3.30.27', inputs: { release_gate: 'true' } };
    expect(ci).toEqual({ method: 'POST', path: 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches', body: ciBody });
    expect(releaseGithubCall('POST', 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches', ciBody)).toEqual({
      args: ['api', '--hostname', 'github.com', '--method', 'POST', '--input', '-', 'repos/ashlrai/phantom/actions/workflows/ci.yml/dispatches'],
      input: '{"ref":"v3.30.27","inputs":{"release_gate":"true"}}',
    });
    const attestBody = {
      ref: 'master',
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

  it('rejects writes outside the sanctioned release paths', () => {
    const bad = { method: 'POST', path: 'repos/ashlrai/phantom/git/refs', body: { sha: head, merge_method: 'merge' } } as ReleaseWrite;
    expect(() => assertReleaseWrite(bad)).toThrow(/refusing/);
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
    };
    const observed = await observeTrain(async (path) => {
      if (!Object.hasOwn(data, path)) throw new Error(`unexpected ${path}`);
      return data[path];
    }, '2026-11-09T06:00:00.000Z', 30, { fleet: 'inactive', autorun: 'inactive' });
    expect(observed.cadenceMinutes).toBe(30);
    expect(observed.head?.ancestry).toBe('ancestor');
    expect(observed.npmPublished).toBe(false);
    expect(buildTrain(observed).state.tag).toBe('v3.30.27');
  });
});
