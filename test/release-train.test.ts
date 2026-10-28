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

const deps = (gh: Runner): ReleaseTrainDeps => ({ gh, git: recorder().run, npm: recorder().run, stopped: () => false });

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
    [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: greenChecks,
    [`repos/${REPO}/contents/package.json?ref=${HEAD}`]: pkg(BUMPED),
    [`repos/${REPO}/commits/${HEAD}/pulls`]: [{ head: { ref: TRAIN_REF }, merged_at: '2026-10-28T09:00:00Z' }],
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
  'workflow', 'run', 'publish-canonical-npm.yml', '--repo', REPO, '--ref', 'master',
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

  it('refuses a red main', async () => {
    const { gh } = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: { check_runs: [
        { id: 9, name: 'CI', status: 'completed', conclusion: 'timed_out' },
      ] },
    }));
    expect(await dispatchReleaseTrain(deps(gh))).toMatchObject({ ok: false, reason: 'main-red', argv: null });
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

  it('refuses when master head is not the merged bump', async () => {
    const { gh } = fakeGh(dispatchTable({
      [`repos/${REPO}/commits/${HEAD}/pulls`]: [{ head: { ref: 'feature/other' }, merged_at: '2026-10-28T09:00:00Z' }],
    }));
    expect(await dispatchReleaseTrain(deps(gh))).toMatchObject({ ok: false, reason: 'not-a-train-merge' });
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
