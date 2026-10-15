import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parsePrRef, repoFromRemote, splitCommand } from '../src/cli/autopilot.js';
import { tick } from '../src/core/autopilot/act.js';
import { emptyState, plan, weakeningRefusals, type CheckRun, type Guards, type Observation } from '../src/core/autopilot/diagnose.js';
import type { Gh } from '../src/core/autopilot/github.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const guards: Guards = { killSwitch: false, paused: false, ownedPrefixes: ['improve/'] };
const run = (id: number, name: string, conclusion: string | null, status = 'completed'): CheckRun => ({ id, name, status, conclusion, app: 'github-actions' });

function obs(over: Partial<Observation> = {}, pr: Partial<Observation['pr']> = {}): Observation {
  return {
    pr: { repo: 'o/r', number: 7, state: 'open', merged: false, draft: false, author: 'bot', headRef: 'improve/x', headSha: HEAD, headRepo: 'o/r', baseRef: 'main', baseSha: BASE, mergeable: true, mergeableState: 'clean', ...pr },
    viewer: 'bot',
    headChecks: [run(1, 'test', 'success'), run(2, 'lint', 'success')],
    baseChecks: [run(10, 'test', 'success'), run(11, 'lint', 'success')],
    logs: {},
    reviews: [],
    ...over,
  };
}

describe('autopilot plan', () => {
  it('fixes a failure this PR caused, then gives up on the same failure after the attempt limit', () => {
    const o = obs({ headChecks: [run(1, 'test', 'failure'), run(2, 'lint', 'success')], logs: { 1: 'FAIL test/a.test.ts > adds\nAssertionError: expected 2 to be 3' } });
    const first = plan(o, guards, emptyState());
    expect(first.action).toBe('fix-ci');
    if (first.action !== 'fix-ci') return;
    const s = emptyState();
    s.attempts[first.signature] = 2;
    expect(plan(o, guards, s)).toMatchObject({ action: 'stop' });
  });

  it('reports failures that are not the PR\'s instead of fixing them', () => {
    const baseRed = obs({ headChecks: [run(1, 'test', 'failure')], baseChecks: [run(10, 'test', 'failure')] });
    expect(plan(baseRed, guards, emptyState())).toMatchObject({ action: 'stop', reason: expect.stringContaining('also red on the base') });
    const flaky = obs({ headChecks: [run(1, 'test', 'success'), run(3, 'test', 'failure')], logs: { 3: 'FAIL timeout' } });
    // The newest run failed but the same commit passed earlier: flaky, not a fix.
    expect(plan(flaky, guards, emptyState())).toMatchObject({ action: 'stop', reason: expect.stringContaining('passed and failed') });
  });

  it('re-runs an infrastructure failure once per head, and stops on the second', () => {
    const o = obs({ headChecks: [run(1, 'test', 'failure')], logs: { 1: '##[error]The hosted runner lost communication with the server.' } });
    expect(plan(o, guards, emptyState())).toMatchObject({ action: 'rerun' });
    expect(plan(o, guards, { ...emptyState(), reruns: [`${HEAD}:test`] })).toMatchObject({ action: 'stop' });
  });

  it('merges the base on conflict before anything else, at most once per head and base', () => {
    const o = obs({ headChecks: [run(1, 'test', 'failure')] }, { mergeable: false, mergeableState: 'dirty' });
    expect(plan(o, guards, emptyState()).action).toBe('merge-base');
    expect(plan(o, guards, { ...emptyState(), attempts: { [`merge-base:${HEAD}:${BASE}`]: 1 } }).action).toBe('stop');
  });

  it('never touches another owner\'s PR, and honors kill and pause', () => {
    expect(plan(obs({}, { headRef: 'codex/release' }), guards, emptyState())).toMatchObject({ action: 'stop', reason: expect.stringContaining('not an autopilot branch') });
    expect(plan(obs({}, { author: 'someone' }), guards, emptyState())).toMatchObject({ action: 'stop' });
    expect(plan(obs({}, { headRepo: 'fork/r' }), guards, emptyState())).toMatchObject({ action: 'stop' });
    expect(plan(obs(), { ...guards, killSwitch: true }, emptyState()).action).toBe('stop');
    expect(plan(obs(), { ...guards, paused: true }, emptyState()).action).toBe('stop');
  });

  it('addresses new review feedback once, waits on pending checks, and reports green', () => {
    const review = { id: 5, kind: 'comment' as const, author: 'mason', body: 'rename this', path: 'a.ts', line: 3, createdAt: '2026-10-15T00:00:00Z' };
    expect(plan(obs({ reviews: [review] }), guards, emptyState()).action).toBe('address-review');
    expect(plan(obs({ reviews: [review] }), guards, { ...emptyState(), handledReviews: [5] }).action).toBe('green');
    expect(plan(obs({ headChecks: [run(1, 'test', null, 'in_progress')] }), guards, emptyState()).action).toBe('wait');
  });

  it('refuses fixes that weaken checks', () => {
    expect(weakeningRefusals([{ path: 'test/a.test.ts', status: 'M', added: ['it.skip("adds", () => {})'] }])).toHaveLength(1);
    expect(weakeningRefusals([{ path: 'test/a.test.ts', status: 'D', added: [] }])).toHaveLength(1);
    expect(weakeningRefusals([{ path: '.github/workflows/ci.yml', status: 'M', added: ['x'] }])).toHaveLength(1);
    expect(weakeningRefusals([{ path: 'src/a.ts', status: 'M', added: ['return a + b;'] }])).toEqual([]);
  });
});

describe('autopilot CLI arguments', () => {
  it('reads PR references, remotes and command strings', () => {
    expect(parsePrRef('#12')).toEqual({ repo: null, number: 12 });
    expect(parsePrRef('https://github.com/ashlrai/phantom/pull/745')).toEqual({ repo: 'ashlrai/phantom', number: 745 });
    expect(parsePrRef('main')).toBeNull();
    expect(repoFromRemote('git@github.com:ashlrai/phantom.git')).toBe('ashlrai/phantom');
    expect(repoFromRemote('https://github.com/ashlrai/phantom')).toBe('ashlrai/phantom');
    expect(splitCommand('claude -p --append-system-prompt "be brief"')).toEqual(['claude', '-p', '--append-system-prompt', 'be brief']);
  });
});

describe('autopilot tick (real git, fake GitHub)', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

  function fixture(fixerBody: string) {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-test-'));
    process.env['ASHLR_HOME'] = join(root, 'home');
    const origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    const clone = join(root, 'clone');
    git(root, 'clone', origin, clone);
    git(clone, 'config', 'user.email', 't@t');
    git(clone, 'config', 'user.name', 't');
    writeFileSync(join(clone, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'init');
    git(clone, 'push', 'origin', 'HEAD:main');
    git(clone, 'push', 'origin', 'HEAD:improve/sum');
    const head = git(clone, 'rev-parse', 'HEAD');
    const fixer = join(root, 'fixer.sh');
    writeFileSync(fixer, `#!/bin/sh\ncat > /dev/null\n${fixerBody}\n`);
    chmodSync(fixer, 0o755);
    const pr = { number: 7, state: 'open', merged: false, draft: false, user: { login: 'bot' }, head: { ref: 'improve/sum', sha: head, repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: head }, mergeable: true, mergeable_state: 'unstable' };
    const gh: Gh = async (args) => {
      const path = args[args.length - 1]!;
      if (path === 'user') return JSON.stringify({ login: 'bot' });
      if (path.endsWith('/pulls/7')) return JSON.stringify(pr);
      if (path.includes('/check-runs')) {
        const red = path.includes(`/commits/${head}/`);
        return JSON.stringify({ check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: red ? 'failure' : 'success', app: { slug: 'github-actions' } }] });
      }
      if (path.endsWith('/logs')) return 'FAIL sum.test.js\nAssertionError: expected -1 to be 3';
      return '[]';
    };
    return { root, origin, clone, head, fixer, gh };
  }

  it('stops without pushing when the same check is red on the base', async () => {
    const f = fixture(`echo 'module.exports = (a, b) => a + b;' > sum.js`);
    // Base and head are the same commit here, so the base reads red too.
    const r = await tick({ repo: 'o/r', number: 7, checkout: f.clone, apply: true, fixer: [f.fixer], verify: [], ownedPrefixes: ['improve/'], gh: f.gh, guards: () => ({ killSwitch: false, paused: false }) });
    expect(r.plan).toBe('stop');
    expect(git(f.clone, 'ls-remote', f.origin, 'refs/heads/improve/sum').split('\t')[0]).toBe(f.head);
  });

  it('pushes a verified fix when the base is green', async () => {
    const f = fixture(`echo 'module.exports = (a, b) => a + b;' > sum.js`);
    const gh: Gh = async (args) => {
      const path = args[args.length - 1]!;
      if (path.endsWith('/pulls/7')) return JSON.stringify({ ...JSON.parse(await f.gh(args)), base: { ref: 'main', sha: 'c'.repeat(40) } });
      return f.gh(args);
    };
    const r = await tick({ repo: 'o/r', number: 7, checkout: f.clone, apply: true, fixer: [f.fixer], verify: [['node', '-e', 'process.exit(require("./sum.js")(1,2)===3?0:1)']], ownedPrefixes: ['improve/'], gh, guards: () => ({ killSwitch: false, paused: false }) });
    expect(r).toMatchObject({ plan: 'fix-ci', result: 'pushed' });
    const remote = git(f.clone, 'ls-remote', f.origin, 'refs/heads/improve/sum').split('\t')[0];
    expect(remote).toBe(r.newHead);
    expect(git(f.clone, 'merge-base', '--is-ancestor', f.head, r.newHead!) === '').toBe(true);
    git(f.clone, 'fetch', 'origin');
    expect(git(f.clone, 'show', 'origin/improve/sum:sum.js')).toContain('a + b');
    expect(readFileSync(join(f.root, 'home', 'autopilot', 'outcomes.jsonl'), 'utf8')).toContain('"result":"pushed"');
  });

  it('refuses a fix that fails verification or skips a test, and pushes nothing', async () => {
    const f = fixture(`echo 'module.exports = (a, b) => a * b;' > sum.js`);
    const gh: Gh = async (args) => (args[args.length - 1]!.endsWith('/pulls/7') ? JSON.stringify({ ...JSON.parse(await f.gh(args)), base: { ref: 'main', sha: 'c'.repeat(40) } }) : f.gh(args));
    const r = await tick({ repo: 'o/r', number: 7, checkout: f.clone, apply: true, fixer: [f.fixer], verify: [['node', '-e', 'process.exit(require("./sum.js")(1,2)===3?0:1)']], ownedPrefixes: ['improve/'], gh, guards: () => ({ killSwitch: false, paused: false }) });
    expect(r.result).toBe('verify-failed');
    expect(git(f.clone, 'ls-remote', f.origin, 'refs/heads/improve/sum').split('\t')[0]).toBe(f.head);
  });
});
