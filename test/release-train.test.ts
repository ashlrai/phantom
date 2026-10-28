/**
 * release-train tests: bump rules, red/held refusal, exact dispatch argv.
 *
 * Every GitHub/git/npm call runs through injected runners that record argv;
 * nothing touches the network, a real checkout, credentials or a real HOME.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  commitBump,
  decideBump,
  dispatchReleaseTrain,
  openReleaseBumpPr,
  planReleaseTrain,
  releaseTrainArmed,
  type ReleaseTrainDeps,
  type Runner,
} from '../src/core/release-train.js';
import { cmdReleaseTrain, RELEASE_TRAIN_USAGE } from '../src/cli/release-train.js';

const REPO = 'ashlrai/phantom';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const TAG = 'v3.28.0';
const VERSION = '3.28.0';
const BUMPED = '3.28.1';
const TRAIN_REF = `release-train/v${BUMPED}`;

const pkg = (version: string) => ({ content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version })).toString('base64') });
const greenChecks = { check_runs: [
  { id: 11, name: 'CI', status: 'completed', conclusion: 'success' },
  { id: 12, name: 'Audit', status: 'completed', conclusion: 'neutral' },
] };
/** Bump-sha check inventory with the macOS + Windows legs the full master suite produces. */
const dispatchChecks = { check_runs: [
  ...greenChecks.check_runs,
  { id: 13, name: 'CI (Node 22, macos, shared queue authority)', status: 'completed', conclusion: 'success' },
  { id: 14, name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'success' },
  { id: 15, name: 'Mac exhaustive (isolated)', status: 'completed', conclusion: 'success' },
  { id: 16, name: 'CI (Node 22, windows, portability 1/3)', status: 'completed', conclusion: 'success' },
  { id: 17, name: 'Windows service authority (Server 2022)', status: 'completed', conclusion: 'success' },
] };
const SUITE_PATH = `repos/${REPO}/actions/workflows/ci.yml/runs?branch=master&per_page=10`;
const suiteRun = (fields: Record<string, unknown>) => ({ id: 555, run_attempt: 1, head_sha: HEAD, event: 'schedule', status: 'completed', conclusion: 'success', ...fields });
const OPEN_PRS = `repos/${REPO}/pulls?state=open&per_page=100&page=1`;
const OPEN_ISSUES = `repos/${REPO}/issues?state=open&per_page=100&page=1`;

/** argv-recording `gh` runner driven by an exact path -> JSON payload table. */
function fakeGh(table: Record<string, unknown>) {
  const calls: string[][] = [];
  const gh: Runner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'api') {
      const path = args[args.length - 1]!;
      if (Object.hasOwn(table, path)) {
        const payload = table[path];
        if (payload instanceof Error) throw payload;
        return JSON.stringify(payload);
      }
      throw new Error(`HTTP 404: Not Found (${path})`);
    }
    if (args[0] === 'workflow') return '';
    if (args[0] === 'pr') return 'https://github.com/ashlrai/phantom/pull/4242\n';
    throw new Error(`unexpected gh argv: ${args.join(' ')}`);
  };
  return { calls, gh };
}

const recorder = () => {
  const calls: string[][] = [];
  const run: Runner = async (args) => { calls.push([...args]); return ''; };
  return { calls, run };
};

const deps = (gh: Runner): ReleaseTrainDeps => ({ gh, git: recorder().run, npm: recorder().run, stopped: () => false, armed: () => true });

function planTable(overrides: Record<string, unknown> = {}) {
  return {
    [`repos/${REPO}`]: { default_branch: 'master' },
    [`repos/${REPO}/branches/master`]: { commit: { sha: HEAD } },
    [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: greenChecks,
    [`repos/${REPO}/contents/package.json?ref=${HEAD}`]: pkg(VERSION),
    [`repos/${REPO}/releases/latest`]: { tag_name: TAG },
    [`repos/${REPO}/compare/${TAG}...${HEAD}`]: { commits: [{ commit: { message: 'fix(cli): repair flag parsing' } }] },
    ...overrides,
  };
}

function dispatchTable(overrides: Record<string, unknown> = {}) {
  return {
    [`repos/${REPO}`]: { default_branch: 'master' },
    [`repos/${REPO}/branches/master`]: { commit: { sha: HEAD } },
    [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: dispatchChecks,
    [`repos/${REPO}/contents/package.json?ref=${HEAD}`]: pkg(BUMPED),
    [`repos/${REPO}/commits/${HEAD}/pulls`]: [{ head: { ref: TRAIN_REF }, merged_at: '2026-10-28T09:00:00Z' }],
    [OPEN_PRS]: [],
    [OPEN_ISSUES]: [],
    [SUITE_PATH]: { workflow_runs: [suiteRun({})] },
    [`repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&status=success&per_page=10`]:
      { workflow_runs: [{ id: 111, run_attempt: 2, head_sha: HEAD, event: 'push' }] },
    [`repos/${REPO}/actions/workflows/attest-ci-build.yml/runs?head_sha=${HEAD}&status=success&per_page=10`]:
      { workflow_runs: [{ id: 222, run_attempt: 1, head_sha: HEAD, event: 'workflow_dispatch' }] },
    [`repos/${REPO}/actions/runs/222/artifacts?per_page=100`]:
      { artifacts: [{ id: 333, name: 'ashlr-attested-111-2-222-1', expired: false }] },
    [`repos/${REPO}/actions/workflows/dependency-audit.yml/runs?head_sha=${HEAD}&status=success&per_page=10`]:
      { workflow_runs: [{ id: 444, run_attempt: 1, head_sha: HEAD, event: 'push' }] },
    ...overrides,
  };
}

const EXPECTED_ARGV = [
  'workflow', 'run', 'publish-canonical-npm.yml', '--repo', REPO, '--ref', HEAD,
  '-f', `candidate_sha=${HEAD}`,
  '-f', 'ci_run_id=111', '-f', 'ci_run_attempt=2',
  '-f', 'attestor_run_id=222', '-f', 'attestor_run_attempt=1',
  '-f', 'attested_artifact_id=333',
  '-f', `version=${BUMPED}`,
  '-f', 'audit_run_id=444', '-f', 'audit_run_attempt=1',
];

describe('release-train bump rules', () => {
  it('classifies conventional commits: feat -> minor, fix/perf/revert -> patch, others -> none', () => {
    expect(commitBump('feat: add release planning')).toBe('minor');
    expect(commitBump('feat(cli): scoped feature')).toBe('minor');
    expect(commitBump('fix: repair flag parsing')).toBe('patch');
    expect(commitBump('perf(core): faster scan')).toBe('patch');
    expect(commitBump('revert: undo the thing')).toBe('patch');
    expect(commitBump('docs: update readme')).toBe('none');
    expect(commitBump('chore(release): v3.28.1')).toBe('none');
    expect(commitBump('bridge(RQ-1): handoff')).toBe('none');
    expect(commitBump('Merge pull request #9')).toBe('none');
  });

  it('treats breaking changes as manual-only, never an automatic bump', () => {
    expect(commitBump('feat!: drop the old flag')).toBe('breaking');
    expect(commitBump('fix(api)!: change the contract')).toBe('breaking');
    expect(commitBump('fix: small\n\nBREAKING CHANGE: renamed the file')).toBe('breaking');
    expect(decideBump(['fix: a', 'feat!: b']).bump).toBe('none');
    expect(decideBump(['feat!: b']).reason).toBe('breaking-change-needs-manual-release');
  });

  it('decides patch/minor/none over the whole compare window', () => {
    expect(decideBump(['fix: a', 'docs: b'])).toEqual({ bump: 'patch', reason: 'ready' });
    expect(decideBump(['fix: a', 'feat: b', 'docs: c'])).toEqual({ bump: 'minor', reason: 'ready' });
    expect(decideBump(['docs: a', 'chore: b'])).toEqual({ bump: 'none', reason: 'no-releasing-commits' });
    expect(decideBump([])).toEqual({ bump: 'none', reason: 'no-releasing-commits' });
  });
});

describe('release-train plan', () => {
  it('plans a patch bump with PR identity on green main', async () => {
    const { gh } = fakeGh(planTable());
    const plan = await planReleaseTrain(deps(gh));
    expect(plan).toMatchObject({
      ok: true, reason: 'ready', gate: 'green', bump: 'patch',
      currentVersion: VERSION, nextVersion: BUMPED,
      prBranch: TRAIN_REF, title: `release: v${BUMPED}`, since: TAG, commits: 1, head: HEAD,
    });
  });

  it('plans a minor bump when a feat commit is in range', async () => {
    const { gh } = fakeGh(planTable({
      [`repos/${REPO}/compare/${TAG}...${HEAD}`]: { commits: [{ commit: { message: 'feat: ship the thing' } }, { commit: { message: 'fix: and its bug' } }] },
    }));
    const plan = await planReleaseTrain(deps(gh));
    expect(plan).toMatchObject({ ok: true, bump: 'minor', nextVersion: '3.29.0', prBranch: 'release-train/v3.29.0' });
  });

  it('plans none and stays idle when nothing releasable landed', async () => {
    const { gh } = fakeGh(planTable({
      [`repos/${REPO}/compare/${TAG}...${HEAD}`]: { commits: [{ commit: { message: 'docs: words' } }] },
    }));
    const plan = await planReleaseTrain(deps(gh));
    expect(plan).toMatchObject({ ok: false, bump: 'none', reason: 'no-releasing-commits', nextVersion: null });
  });

  it('refuses a red main', async () => {
    const { gh } = fakeGh(planTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: [
        { id: 11, name: 'CI', status: 'completed', conclusion: 'failure' },
      ] },
    }));
    const plan = await planReleaseTrain(deps(gh));
    expect(plan).toMatchObject({ ok: false, gate: 'red', reason: 'main-red' });
  });

  it('refuses a held main via the RELEASE_HOLD variable', async () => {
    const { gh } = fakeGh(planTable({
      [`repos/${REPO}/actions/variables/RELEASE_HOLD`]: { name: 'RELEASE_HOLD', value: 'freeze for incident' },
    }));
    const plan = await planReleaseTrain(deps(gh));
    expect(plan).toMatchObject({ ok: false, gate: 'held', hold: 'freeze for incident', reason: 'held:freeze for incident' });
  });

  it('refuses when the local kill switch is engaged, before any network read', async () => {
    const { calls, gh } = fakeGh(planTable());
    const plan = await planReleaseTrain({ gh, stopped: () => true });
    expect(plan).toMatchObject({ ok: false, gate: 'stopped', reason: 'stopped' });
    expect(calls).toEqual([]);
  });
});

describe('release-train open', () => {
  it('pushes the bump branch (never tags) and opens the PR with exact argv', async () => {
    const faked = fakeGh(planTable({ [`repos/${REPO}/pulls?state=open&head=ashlrai:${TRAIN_REF}&per_page=5`]: [] }));
    const git = recorder();
    const npm = recorder();
    const result = await openReleaseBumpPr({ gh: faked.gh, git: git.run, npm: npm.run, stopped: () => false });
    expect(result).toMatchObject({ ok: true, reason: 'opened', prUrl: 'https://github.com/ashlrai/phantom/pull/4242' });
    expect(git.calls).toEqual([
      ['status', '--porcelain'],
      ['fetch', 'origin', 'master'],
      ['checkout', '-B', TRAIN_REF, 'origin/master'],
      ['add', '-A'],
      ['commit', '-m', `chore(release): v${BUMPED}`],
      ['push', '-u', 'origin', TRAIN_REF],
    ]);
    expect(npm.calls).toEqual([['run', 'version:sync', '--', BUMPED]]);
    const prCreate = faked.calls.find((c) => c[0] === 'pr' && c[1] === 'create');
    expect(prCreate?.slice(0, 8)).toEqual(['pr', 'create', '--repo', REPO, '--base', 'master', '--head', TRAIN_REF]);
  });

  it('never emits tag pushes or force flags', async () => {
    const faked = fakeGh(planTable({ [`repos/${REPO}/pulls?state=open&head=ashlrai:${TRAIN_REF}&per_page=5`]: [] }));
    const git = recorder();
    await openReleaseBumpPr({ gh: faked.gh, git: git.run, npm: recorder().run, stopped: () => false });
    const flat = git.calls.flat();
    expect(flat).not.toContain('--tags');
    expect(flat).not.toContain('--follow-tags');
    expect(flat).not.toContain('--force');
    expect(flat).not.toContain('tag');
    const prCreate = faked.calls.find((c) => c[0] === 'pr' && c[1] === 'create');
    expect(prCreate).toEqual(['pr', 'create', '--repo', REPO, '--base', 'master', '--head', TRAIN_REF,
      '--title', `release: v${BUMPED}`, '--body', expect.stringContaining(`${VERSION} -> ${BUMPED} (patch)`)]);
  });

  it('returns an already-open bump PR instead of duplicating it', async () => {
    const { gh } = fakeGh(planTable({
      [`repos/${REPO}/pulls?state=open&head=ashlrai:${TRAIN_REF}&per_page=5`]: [{ html_url: 'https://github.com/ashlrai/phantom/pull/99' }],
    }));
    const git = recorder();
    const result = await openReleaseBumpPr({ gh, git: git.run, npm: recorder().run, stopped: () => false });
    expect(result).toMatchObject({ ok: true, reason: 'already-open', alreadyOpen: true, prUrl: 'https://github.com/ashlrai/phantom/pull/99' });
    expect(git.calls).toEqual([]);
  });

  it('refuses a dirty worktree so unrelated changes never ride the bump commit', async () => {
    const faked = fakeGh(planTable({ [`repos/${REPO}/pulls?state=open&head=ashlrai:${TRAIN_REF}&per_page=5`]: [] }));
    const git: Runner = async (args) => (args[0] === 'status' ? ' M src/cli/index.ts\n' : '');
    const result = await openReleaseBumpPr({ gh: faked.gh, git, npm: recorder().run, stopped: () => false });
    expect(result).toMatchObject({ ok: false, reason: 'dirty-worktree' });
  });

  it('refuses to mutate on a held main', async () => {
    const { gh } = fakeGh(planTable({
      [`repos/${REPO}/actions/variables/RELEASE_HOLD`]: { name: 'RELEASE_HOLD', value: '1' },
    }));
    const git = recorder();
    const result = await openReleaseBumpPr({ gh, git: git.run, npm: recorder().run, stopped: () => false });
    expect(result.ok).toBe(false);
    expect(git.calls).toEqual([]);
  });
});

describe('release-train dispatch', () => {
  it('runs the one sanctioned workflow with exact argv after the bump merge', async () => {
    const faked = fakeGh(dispatchTable());
    const result = await dispatchReleaseTrain(deps(faked.gh));
    expect(result).toEqual({ ok: true, reason: 'ready', repo: REPO, workflow: 'publish-canonical-npm.yml', argv: EXPECTED_ARGV, dispatched: true });
    expect(faked.calls.at(-1)).toEqual(EXPECTED_ARGV);
  });

  it('reports argv without running on --dry-run', async () => {
    const faked = fakeGh(dispatchTable());
    const result = await dispatchReleaseTrain(deps(faked.gh), { dryRun: true });
    expect(result).toEqual({ ok: true, reason: 'ready', repo: REPO, workflow: 'publish-canonical-npm.yml', argv: EXPECTED_ARGV, dispatched: false });
    expect(faked.calls.some((c) => c[0] === 'workflow')).toBe(false);
  });

  it('never dispatches when PHANTOM_RELEASE_TRAIN is unset: the flag-off path is a dry run', async () => {
    const faked = fakeGh(dispatchTable());
    const unarmed = { gh: faked.gh, stopped: () => false, armed: () => false };
    const result = await dispatchReleaseTrain(unarmed);
    expect(result).toEqual({ ok: true, reason: 'flag-off-dry-run', repo: REPO, workflow: 'publish-canonical-npm.yml', argv: EXPECTED_ARGV, dispatched: false });
    // No `armed` dep at all fails just as closed.
    const missing = fakeGh(dispatchTable());
    const absent = await dispatchReleaseTrain({ gh: missing.gh, stopped: () => false });
    expect(absent).toMatchObject({ ok: true, reason: 'flag-off-dry-run', argv: EXPECTED_ARGV, dispatched: false });
    for (const calls of [faked.calls, missing.calls]) {
      expect(calls.some((c) => c[0] === 'workflow')).toBe(false);
    }
  });

  it('arms only on the exact value PHANTOM_RELEASE_TRAIN=1', () => {
    expect(releaseTrainArmed({})).toBe(false);
    expect(releaseTrainArmed({ PHANTOM_RELEASE_TRAIN: '0' })).toBe(false);
    expect(releaseTrainArmed({ PHANTOM_RELEASE_TRAIN: 'true' })).toBe(false);
    expect(releaseTrainArmed({ PHANTOM_RELEASE_TRAIN: 'yes' })).toBe(false);
    expect(releaseTrainArmed({ PHANTOM_RELEASE_TRAIN: '1' })).toBe(true);
  });

  it('gate1 refuses when master head is not the merged bump PR', async () => {
    const notMerged = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/pulls`]: [{ head: { ref: 'feature/other' }, merged_at: '2026-10-28T09:00:00Z' }],
    }));
    expect(await dispatchReleaseTrain(deps(notMerged.gh))).toMatchObject({ ok: false, reason: 'gate1-bump-not-merged', argv: null, dispatched: false });
    const unmerged = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/pulls`]: [{ head: { ref: TRAIN_REF }, merged_at: null }],
    }));
    expect(await dispatchReleaseTrain(deps(unmerged.gh))).toMatchObject({ ok: false, reason: 'gate1-bump-not-merged' });
  });

  it('gate1 refuses when the bumped version is not semver', async () => {
    const { gh } = fakeGh(dispatchTable({
      [`repos/${REPO}/contents/package.json?ref=${HEAD}`]: pkg('3.28.x-nightly'),
    }));
    expect(await dispatchReleaseTrain(deps(gh))).toMatchObject({ ok: false, reason: 'gate1-version-unreadable' });
  });

  it('gate2 refuses an open P0 DAILYFIX PR for the repo', async () => {
    const { gh, calls } = fakeGh(dispatchTable({
      [OPEN_PRS]: [{ number: 42, title: 'RQ-DAILYFIX-9 (P0): repair the broken main', head: { ref: 'codex-bridge/RQ-DAILYFIX-9' }, labels: [] }],
    }));
    expect(await dispatchReleaseTrain(deps(gh))).toMatchObject({ ok: false, reason: 'gate2-dailyfix-p0-open:#42', argv: null, dispatched: false });
    expect(calls.some((c) => c[0] === 'workflow')).toBe(false);
  });

  it('gate2 refuses an open P0 DAILYFIX queue line (issue or label form)', async () => {
    const byIssue = fakeGh(dispatchTable({
      [OPEN_ISSUES]: [{ number: 77, title: 'DAILYFIX-3 (P0, repo=phantom): master red', labels: [] }],
    }));
    expect(await dispatchReleaseTrain(deps(byIssue.gh))).toMatchObject({ ok: false, reason: 'gate2-dailyfix-p0-open:#77' });
    const byLabel = fakeGh(dispatchTable({
      [OPEN_PRS]: [{ number: 78, title: 'dailyfix: unbreak the gate', head: { ref: 'fix/dailyfix' }, labels: [{ name: 'P0' }] }],
    }));
    expect(await dispatchReleaseTrain(deps(byLabel.gh))).toMatchObject({ ok: false, reason: 'gate2-dailyfix-p0-open:#78' });
  });

  it('gate2 fails closed on a DAILYFIX item whose priority cannot be parsed', async () => {
    const { gh } = fakeGh(dispatchTable({
      [OPEN_PRS]: [{ number: 88, title: 'DAILYFIX-4: outstanding repair', head: { ref: 'bot/dailyfix-4' }, labels: [] }],
    }));
    expect(await dispatchReleaseTrain(deps(gh))).toMatchObject({ ok: false, reason: 'gate2-dailyfix-priority-unparseable:#88' });
  });

  it('gate2 lets an explicitly non-P0 DAILYFIX line through', async () => {
    const faked = fakeGh(dispatchTable({
      [OPEN_PRS]: [{ number: 90, title: 'RQ-DAILYFIX-2 (P2): cosmetic wording', head: { ref: 'codex-bridge/RQ-DAILYFIX-2' }, labels: [] }],
    }));
    const result = await dispatchReleaseTrain(deps(faked.gh));
    expect(result).toMatchObject({ ok: true, dispatched: true });
  });

  it('gate3 refuses when the latest full-suite master run is not green', async () => {
    const red = fakeGh(dispatchTable({ [SUITE_PATH]: { workflow_runs: [suiteRun({ conclusion: 'failure' })] } }));
    expect(await dispatchReleaseTrain(deps(red.gh))).toMatchObject({ ok: false, reason: 'gate3-full-suite-failure', argv: null });
    const pending = fakeGh(dispatchTable({ [SUITE_PATH]: { workflow_runs: [suiteRun({ status: 'in_progress', conclusion: null })] } }));
    expect(await dispatchReleaseTrain(deps(pending.gh))).toMatchObject({ ok: false, reason: 'gate3-full-suite-pending' });
    const missing = fakeGh(dispatchTable({ [SUITE_PATH]: { workflow_runs: [suiteRun({ event: 'push' })] } }));
    expect(await dispatchReleaseTrain(deps(missing.gh))).toMatchObject({ ok: false, reason: 'gate3-full-suite-missing' });
  });

  it('gate4 refuses when any check on the bump sha is red or pending', async () => {
    const red = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: [
        ...dispatchChecks.check_runs,
        { id: 18, name: 'CI (Node 22, ubuntu, authority 1/3)', status: 'completed', conclusion: 'timed_out' },
      ] },
    }));
    expect(await dispatchReleaseTrain(deps(red.gh))).toMatchObject({ ok: false, reason: 'gate4-checks-red', argv: null });
    const pending = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: [
        ...dispatchChecks.check_runs,
        { id: 19, name: 'Docs PR (docs-only)', status: 'in_progress', conclusion: null },
      ] },
    }));
    expect(await dispatchReleaseTrain(deps(pending.gh))).toMatchObject({ ok: false, reason: 'gate4-checks-pending' });
  });

  it('gate4 refuses when the macOS legs since the bump are missing, pending or red', async () => {
    const legs = (id: number, status: string, conclusion: string | null) => [
      ...dispatchChecks.check_runs.filter((c) => !/macos|\bmac\b/i.test(c.name)),
      { id, name: 'Mac exhaustive (1/4)', status, conclusion },
    ];
    const missing = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: {
        check_runs: dispatchChecks.check_runs.filter((c) => !/macos|\bmac\b/i.test(c.name)),
      },
    }));
    expect(await dispatchReleaseTrain(deps(missing.gh))).toMatchObject({ ok: false, reason: 'gate4-mac-missing' });
    const pending = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: legs(20, 'in_progress', null) },
    }));
    expect(await dispatchReleaseTrain(deps(pending.gh))).toMatchObject({ ok: false, reason: 'gate4-mac-pending' });
    const red = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: legs(21, 'completed', 'failure') },
    }));
    expect(await dispatchReleaseTrain(deps(red.gh))).toMatchObject({ ok: false, reason: 'gate4-mac-red' });
    const skipped = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: legs(22, 'completed', 'skipped') },
    }));
    expect(await dispatchReleaseTrain(deps(skipped.gh))).toMatchObject({ ok: false, reason: 'gate4-mac-pending' });
  });

  it('gate4 refuses when the Windows legs since the bump are missing, pending or red', async () => {
    const withoutWin = dispatchChecks.check_runs.filter((c) => !/\bwindows\b/i.test(c.name));
    const missing = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: withoutWin },
    }));
    expect(await dispatchReleaseTrain(deps(missing.gh))).toMatchObject({ ok: false, reason: 'gate4-win-missing' });
    const pending = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: [
        ...withoutWin,
        { id: 23, name: 'CI (Node 22, windows, portability 2/3)', status: 'queued', conclusion: null },
      ] },
    }));
    expect(await dispatchReleaseTrain(deps(pending.gh))).toMatchObject({ ok: false, reason: 'gate4-win-pending' });
    const red = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: [
        ...withoutWin,
        { id: 24, name: 'Windows service authority (Server 2022)', status: 'completed', conclusion: 'cancelled' },
      ] },
    }));
    expect(await dispatchReleaseTrain(deps(red.gh))).toMatchObject({ ok: false, reason: 'gate4-win-red' });
  });

  it('refuses a held main', async () => {
    const { gh } = fakeGh(dispatchTable({
      [`repos/${REPO}/actions/variables/RELEASE_HOLD`]: { name: 'RELEASE_HOLD', value: 'incident freeze' },
    }));
    expect(await dispatchReleaseTrain(deps(gh))).toMatchObject({ ok: false, reason: 'held:incident freeze' });
  });

  it('refuses when the kill switch is engaged', async () => {
    const { calls, gh } = fakeGh(dispatchTable());
    expect(await dispatchReleaseTrain({ gh, stopped: () => true })).toMatchObject({ ok: false, reason: 'stopped' });
    expect(calls).toEqual([]);
  });

  it('a gh error inside any gate refuses and names the refusing gate', async () => {
    const at = (path: string) => fakeGh(dispatchTable({ [path]: new Error('gh exploded') }));
    expect(await dispatchReleaseTrain(deps(at(`repos/${REPO}/commits/${HEAD}/pulls`).gh))).toMatchObject({ ok: false, reason: 'gate1-error:gh exploded' });
    expect(await dispatchReleaseTrain(deps(at(OPEN_PRS).gh))).toMatchObject({ ok: false, reason: 'gate2-error:gh exploded' });
    expect(await dispatchReleaseTrain(deps(at(SUITE_PATH).gh))).toMatchObject({ ok: false, reason: 'gate3-error:gh exploded' });
    expect(await dispatchReleaseTrain(deps(at(`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`).gh))).toMatchObject({ ok: false, reason: 'gate4-error:gh exploded' });
    const dispatch = fakeGh(dispatchTable());
    const failing: Runner = (args) => (args[0] === 'workflow' ? Promise.reject(new Error('dispatch denied')) : dispatch.gh(args));
    expect(await dispatchReleaseTrain(deps(failing))).toMatchObject({ ok: false, reason: 'dispatch-error:dispatch denied', argv: EXPECTED_ARGV, dispatched: false });
  });

  it('refuses when the qualified CI, attestor, artifact or audit evidence is missing', async () => {
    const noCi = fakeGh(dispatchTable({ [`repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&status=success&per_page=10`]: { workflow_runs: [] } }));
    expect(await dispatchReleaseTrain(deps(noCi.gh))).toMatchObject({ ok: false, reason: 'ci-missing' });
    const noAttestor = fakeGh(dispatchTable({ [`repos/${REPO}/actions/workflows/attest-ci-build.yml/runs?head_sha=${HEAD}&status=success&per_page=10`]: { workflow_runs: [] } }));
    expect(await dispatchReleaseTrain(deps(noAttestor.gh))).toMatchObject({ ok: false, reason: 'attestor-missing' });
    const noArtifact = fakeGh(dispatchTable({ [`repos/${REPO}/actions/runs/222/artifacts?per_page=100`]: { artifacts: [{ id: 334, name: 'ashlr-attested-999-1-222-1', expired: false }] } }));
    expect(await dispatchReleaseTrain(deps(noArtifact.gh))).toMatchObject({ ok: false, reason: 'artifact-missing' });
    const noAudit = fakeGh(dispatchTable({ [`repos/${REPO}/actions/workflows/dependency-audit.yml/runs?head_sha=${HEAD}&status=success&per_page=10`]: { workflow_runs: [] } }));
    expect(await dispatchReleaseTrain(deps(noAudit.gh))).toMatchObject({ ok: false, reason: 'audit-missing' });
  });

  it('pins --ref to the exact bump sha and the workflow file, never a branch name', async () => {
    const faked = fakeGh(dispatchTable());
    const result = await dispatchReleaseTrain(deps(faked.gh));
    expect(result.argv!.at(result.argv!.indexOf('--ref') + 1)).toBe(HEAD);
    expect(result.argv).not.toContain('master');
    expect(result.argv![2]).toBe('publish-canonical-npm.yml');
    expect(result.argv).toContain(`version=${BUMPED}`);
  });

  it('never builds argv containing admin, tag or force flags for any path', async () => {
    const faked = fakeGh(dispatchTable());
    const result = await dispatchReleaseTrain(deps(faked.gh));
    expect(result.argv!.join(' ')).not.toMatch(/--admin|--force|tag/);
  });
});

describe('release-train CLI', () => {
  it('prints usage on --help and bad usage exits 2', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdReleaseTrain(['--help'])).toBe(0);
      expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain(RELEASE_TRAIN_USAGE);
    } finally {
      write.mockRestore();
    }
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdReleaseTrain(['frobnicate'])).toBe(2);
      expect(await cmdReleaseTrain(['dispatch', '--bogus'])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});
