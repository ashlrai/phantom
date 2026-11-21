import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MERGE_RECUT_BRANCH_RE, executeMergeRecut, makeMergeRecutResolver, planMergeRecut,
  type MergeRecutRunner,
} from '../src/core/fleet/merge-recut.js';
import { makeRecutRunner } from '../scripts/merge-queue-loop.mjs';

const REPO = 'ashlrai/phantom';
const BRANCH = 'codex-bridge/RQ-MERGERECUTTEST';
const sha40 = (seed: string) => seed.repeat(40).slice(0, 40);

const eligiblePr = (over: Record<string, unknown> = {}) => ({
  number: 9, headSha: sha40('a'), headRef: BRANCH, headRepo: REPO, baseRef: 'master',
  isDraft: false, inMergeQueue: false, files: ['src/core/x.ts', 'test/x.test.ts'], filesTruncated: false,
  ...over,
});

describe('planMergeRecut', () => {
  it('plans the recut for an eligible fleet PR', () => {
    expect(planMergeRecut({ repo: REPO, defaultBranch: 'master', pr: eligiblePr() })).toEqual({
      ok: true, plan: { repo: REPO, number: 9, headSha: sha40('a'), headRef: BRANCH, baseRef: 'master' },
    });
  });
  it.each([
    ['repo', { repo: 'ashlrai/unknown' }],
    ['repo', { repo: 'evil/phantom' }],
    ['pr', { pr: { number: 0 } }],
    ['head', { pr: { headSha: 'abc' } }],
    ['branch', { pr: { headRef: 'feature/x' } }],
    ['branch', { pr: { headRef: 'codex-bridge/../escape' } }],
    ['fork', { pr: { headRepo: 'someone/phantom' } }],
    ['fork', { pr: { headRepo: null } }],
    ['base', { defaultBranch: 'release', pr: { baseRef: 'master' } }],
    ['base', { defaultBranch: '-x', pr: { baseRef: '-x' } }],
    ['draft', { pr: { isDraft: true } }],
    ['queued', { pr: { inMergeQueue: true } }],
    ['files', { pr: { filesTruncated: true } }],
    ['pinned', { pr: { files: ['src/core/x.ts', '.github/workflows/ci.yml'] } }],
    ['pinned', { pr: { files: ['bin/dispatchd.py'] } }],
  ] as [string, Record<string, unknown>][])('refuses %s: %j', (reason, over) => {
    const input = {
      repo: REPO,
      defaultBranch: 'master',
      pr: eligiblePr(),
      ...(over as { repo?: string; defaultBranch?: string; pr?: Partial<ReturnType<typeof eligiblePr>> }),
    };
    if (over.pr) input.pr = { ...input.pr, ...(over.pr as Partial<ReturnType<typeof eligiblePr>>) };
    expect(planMergeRecut(input)).toEqual({ ok: false, reason });
  });
  it('recognizes every fleet head branch shape it may recut', () => {
    expect(MERGE_RECUT_BRANCH_RE.test('codex-bridge/RQ-MERGELATENCYN21Q8')).toBe(true);
    expect(MERGE_RECUT_BRANCH_RE.test('codex-bridge/a_b-C1')).toBe(true);
    expect(MERGE_RECUT_BRANCH_RE.test('main')).toBe(false);
    expect(MERGE_RECUT_BRANCH_RE.test('codex-bridge/x y')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real-git fixtures against a local bare origin: clean, conflict, retry and
// already-merged cases, mirroring test/conflict-resolve.test.ts.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd: string | undefined, args: string[], opts: { allowFail?: boolean } = {}): { code: number; stdout: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: 0, stdout: stdout ?? '' };
  } catch (error) {
    if (opts.allowFail && typeof (error as { status?: unknown }).status === 'number') {
      return { code: (error as { status: number }).status, stdout: String((error as { stdout?: string }).stdout ?? '') };
    }
    throw error;
  }
}

const put = (seed: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(seed, dirnameOf(path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-m', 'c']);
};
const dirnameOf = (path: string) => path.split('/').slice(0, -1).join('/');

/** A bare origin with master advanced past the PR branch, plus refs/pull/9/head. */
function setupOrigin(files: { base: Record<string, string>; master: Record<string, string>; pr: Record<string, string> }): {
  origin: string; seed: string; prHead: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'merge-recut-origin-'));
  dirs.push(root);
  const origin = join(root, 'origin.git'), seed = join(root, 'seed');
  sh(undefined, ['init', '--bare', '-b', 'master', origin]);
  sh(undefined, ['init', '-b', 'master', seed]);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']] as const) {
    sh(seed, ['config', key, value]);
  }
  sh(seed, ['remote', 'add', 'origin', origin]);
  put(seed, files.base);
  sh(seed, ['push', 'origin', 'master']);
  sh(seed, ['checkout', '-b', BRANCH]);
  put(seed, files.pr);
  sh(seed, ['push', 'origin', BRANCH]);
  const prHead = sh(seed, ['rev-parse', 'HEAD']).stdout.trim();
  sh(origin, ['update-ref', 'refs/pull/9/head', prHead]);
  sh(seed, ['checkout', 'master']);
  put(seed, files.master);
  sh(seed, ['push', 'origin', 'master']);
  return { origin, seed, prHead };
}

const originTip = (origin: string, ref: string): string =>
  sh(origin, ['rev-parse', ref]).stdout.trim();

/** Test runner: real git, deterministic stand-in generators. */
const testRunner = (generatorsOk = true): MergeRecutRunner & { roots: string[] } => {
  const roots: string[] = [];
  return {
    roots,
    git: (args, opts) => sh(opts?.cwd, [...args], { allowFail: opts?.allowFail }),
    readFile: path => readFileSync(path, 'utf8'),
    writeFile: (path, text) => { writeFileSync(path, text); },
    mkdir: path => { mkdirSync(path, { recursive: true }); },
    mkdtemp: prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir; },
    rmrf: path => { rmSync(path, { recursive: true, force: true }); },
    run: (cwd, argv) => {
      if (!generatorsOk) return false;
      // Stand-in generators: rewrite their declared outputs deterministically.
      if (argv.some(part => part.includes('generate-docs-llms'))) {
        writeFileSync(join(cwd, 'docs/llms.txt'), 'regenerated\n');
        return true;
      }
      if (argv.includes('install')) {
        writeFileSync(join(cwd, 'package-lock.json'), '{"regenerated":true}\n');
        return true;
      }
      return false;
    },
  };
};

const plan = (headSha: string) => ({ repo: REPO, number: 9, headSha, headRef: BRANCH, baseRef: 'master' });

describe('executeMergeRecut (real git against a local origin)', () => {
  it('clean case: merges the current default branch in and pushes one fast-forward merge commit', () => {
    const { origin, prHead } = setupOrigin({
      base: { 'src/a.ts': '1\n' }, master: { 'src/b.ts': 'm\n' }, pr: { 'src/c.ts': 'p\n' },
    });
    const runner = testRunner();
    const outcome = executeMergeRecut(runner, plan(prHead), origin);
    expect(outcome).toMatchObject({ status: 'resolved', pushed: true });
    if (outcome.status !== 'resolved') throw new Error('unreachable');
    expect(originTip(origin, `refs/heads/${BRANCH}`)).toBe(outcome.commit);
    // A merge commit on top of the pinned head: both parents, no rewrite.
    expect(sh(origin, ['rev-list', '--parents', '-n1', outcome.commit]).stdout.trim().split(' '))
      .toEqual([outcome.commit, prHead, originTip(origin, 'refs/heads/master')]);
    // The recut branch carries both sides of the change.
    const tree = sh(origin, ['ls-tree', '-r', '--name-only', outcome.commit]).stdout;
    expect(tree).toContain('src/b.ts');
    expect(tree).toContain('src/c.ts');
    // The disposable store is gone.
    expect(runner.roots.every(dir => !existsSync(dir))).toBe(true);
  });

  it('conflict case: unions the changelog, regenerates the lockfile and pushes', () => {
    const { origin, prHead } = setupOrigin({
      base: { 'CHANGELOG.md': '# Log\n', 'package-lock.json': '{}\n', 'docs/llms.txt': 'v0\n' },
      master: { 'CHANGELOG.md': '# Log\n- master entry\n', 'package-lock.json': '{"m":1}\n', 'docs/llms.txt': 'master\n' },
      pr: { 'CHANGELOG.md': '# Log\n- pr entry\n', 'package-lock.json': '{"p":1}\n', 'docs/llms.txt': 'pr\n' },
    });
    const runner = testRunner();
    const outcome = executeMergeRecut(runner, plan(prHead), origin);
    expect(outcome).toMatchObject({
      status: 'resolved', pushed: true,
      resolved: ['CHANGELOG.md', 'docs/llms.txt', 'package-lock.json'],
    });
    if (outcome.status !== 'resolved') throw new Error('unreachable');
    expect(sh(origin, ['show', `${outcome.commit}:CHANGELOG.md`]).stdout).toContain('- master entry');
    expect(sh(origin, ['show', `${outcome.commit}:CHANGELOG.md`]).stdout).toContain('- pr entry');
    expect(sh(origin, ['show', `${outcome.commit}:package-lock.json`]).stdout).toBe('{"regenerated":true}\n');
  });

  it('real conflict: never pushes and leaves the branch at the observed head', () => {
    const { origin, prHead } = setupOrigin({
      base: { 'src/a.ts': 'x\n', 'package-lock.json': '{}\n' },
      master: { 'src/a.ts': 'm\n', 'package-lock.json': '{"m":1}\n' },
      pr: { 'src/a.ts': 'p\n', 'package-lock.json': '{"p":1}\n' },
    });
    const outcome = executeMergeRecut(testRunner(), plan(prHead), origin);
    expect(outcome).toEqual({ status: 'real', reason: 'content-conflict' });
    expect(originTip(origin, `refs/heads/${BRANCH}`)).toBe(prHead);
  });

  it('failing generator: is a real conflict, never a guess', () => {
    const { origin, prHead } = setupOrigin({
      base: { 'package-lock.json': '{}\n' }, master: { 'package-lock.json': '{"m":1}\n' }, pr: { 'package-lock.json': '{"p":1}\n' },
    });
    const outcome = executeMergeRecut(testRunner(false), plan(prHead), origin);
    expect(outcome).toEqual({ status: 'real', reason: 'regenerate-failed' });
    expect(originTip(origin, `refs/heads/${BRANCH}`)).toBe(prHead);
  });

  it('retry case: a head that moved since the observation is never repaired', () => {
    const { origin, prHead } = setupOrigin({ base: { 'a.txt': '1\n' }, master: { 'b.txt': 'm\n' }, pr: { 'c.txt': 'p\n' } });
    const other = sha40('f');
    const outcome = executeMergeRecut(testRunner(), plan(other), origin);
    expect(outcome).toEqual({ status: 'transient', reason: 'head-moved' });
    expect(originTip(origin, `refs/heads/${BRANCH}`)).toBe(prHead);
  });

  it('already-merged case: a deleted head branch is refused, never recreated', () => {
    const { origin, prHead } = setupOrigin({ base: { 'a.txt': '1\n' }, master: { 'b.txt': 'm\n' }, pr: { 'c.txt': 'p\n' } });
    sh(origin, ['update-ref', '-d', `refs/heads/${BRANCH}`]);
    const outcome = executeMergeRecut(testRunner(), plan(prHead), origin);
    expect(outcome).toEqual({ status: 'transient', reason: 'branch-gone' });
    expect(sh(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], { allowFail: true }).code).not.toBe(0);
  });

  it('concurrent writer: a moved branch is never overwritten', () => {
    const { origin, seed, prHead } = setupOrigin({ base: { 'a.txt': '1\n' }, master: { 'b.txt': 'm\n' }, pr: { 'c.txt': 'p\n' } });
    sh(seed, ['checkout', BRANCH]);
    writeFileSync(join(seed, 'd.txt'), 'other writer\n');
    sh(seed, ['add', '-A']);
    sh(seed, ['commit', '-m', 'concurrent']);
    sh(seed, ['push', 'origin', BRANCH]);
    const moved = sh(seed, ['rev-parse', 'HEAD']).stdout.trim();
    const outcome = executeMergeRecut(testRunner(), plan(prHead), origin);
    expect(outcome).toEqual({ status: 'transient', reason: 'branch-moved' });
    expect(originTip(origin, `refs/heads/${BRANCH}`)).toBe(moved);
  });

  it('stale conflict report: a head that already contains the base pushes nothing', () => {
    const { origin, seed, prHead } = setupOrigin({ base: { 'a.txt': '1\n' }, master: { 'b.txt': 'm\n' }, pr: { 'c.txt': 'p\n' } });
    sh(seed, ['checkout', BRANCH]);
    sh(seed, ['merge', '--no-edit', 'origin/master']);
    sh(seed, ['push', 'origin', BRANCH]);
    const outcome = executeMergeRecut(testRunner(), plan(prHead), origin);
    expect(outcome).toEqual({ status: 'resolved', commit: prHead, pushed: false, resolved: [] });
    expect(originTip(origin, `refs/heads/${BRANCH}`)).toBe(prHead);
  });

  it('rejects an unsafe remote before any git call', () => {
    expect(() => executeMergeRecut(testRunner(), plan(sha40('a')), '-injected')).toThrow('invalid remote');
  });
});

describe('makeMergeRecutResolver', () => {
  it('refuses ineligible PRs to the lane without touching git', () => {
    const runner = testRunner();
    const calls: string[] = [];
    const resolver = makeMergeRecutResolver({ ...runner, git: (args, opts) => { calls.push(args.join(' ')); return runner.git(args, opts); } });
    expect(resolver(REPO, { ...eligiblePr(), files: ['.github/workflows/ci.yml'] } as never)).toBe('real');
    expect(resolver(REPO, { ...eligiblePr(), headRepo: null } as never)).toBe('real');
    expect(calls).toEqual([]);
  });
  it('maps executor outcomes and never throws', () => {
    const boom: MergeRecutRunner = { ...testRunner(), git: () => { throw new Error('git failed: token=secret'); } };
    const resolver = makeMergeRecutResolver(boom);
    expect(resolver(REPO, eligiblePr() as never)).toBe('transient');
  });
  it('runs the production stack end to end against a local origin', () => {
    const { origin, prHead } = setupOrigin({
      base: { 'CHANGELOG.md': '# Log\n' },
      master: { 'CHANGELOG.md': '# Log\n- master entry\n' },
      pr: { 'CHANGELOG.md': '# Log\n- pr entry\n' },
    });
    const resolver = makeMergeRecutResolver(makeRecutRunner(), () => origin);
    expect(resolver(REPO, eligiblePr({ headSha: prHead }) as never)).toBe('resolved');
    expect(sh(origin, ['show', `refs/heads/${BRANCH}:CHANGELOG.md`]).stdout).toContain('- master entry');
  });
});
