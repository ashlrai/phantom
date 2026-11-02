import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunResult, GitRunner } from '../src/core/verse/git-ops.js';

const roots: string[] = [];
const stale = 'a'.repeat(40);
const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(base = stale) {
  const homeDir = await mkdtemp(join(tmpdir(), 'phx-changes-'));
  roots.push(homeDir);
  const runsDir = join(homeDir, 'runs');
  const repo = join(homeDir, 'repo');
  await mkdir(runsDir); await mkdir(repo);
  await writeFile(join(runsDir, 'RQ-TEST.base'), `${base} branch ${repo}\n`);
  return { homeDir, runsDir, repo };
}

describe('worker changes when the recorded base is unavailable', () => {
  it('reports real tracked and untracked changes against HEAD while retaining base provenance', async () => {
    const opts = await setup();
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: opts.repo, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: opts.homeDir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    git('init', '-q');
    await writeFile(join(opts.repo, 'tracked.txt'), 'old\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    const validBase = git('rev-parse', 'HEAD');
    await writeFile(join(opts.repo, 'tracked.txt'), 'new\nmore\n');
    await writeFile(join(opts.repo, 'new.txt'), 'new\n');
    const runner: GitRunner = (bin, args, options) => new Promise(resolve => {
      execFile(bin, [...args], {
        cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxStdoutBytes, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: opts.homeDir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      }, (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout, stderr, timedOut: error?.killed ?? false,
        truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', missing: error?.code === 'ENOENT',
      }));
    });

    const result = await getFleetJobChanges('RQ-TEST', { ...opts, runner });
    expect(result).toMatchObject({ state: 'degraded', baseSha: stale, comparisonBase: 'HEAD', truncated: false,
      totals: { files: 2, added: 2, removed: 1 } });
    expect(result.files).toEqual(expect.arrayContaining([
      { path: 'tracked.txt', added: 2, removed: 1, status: 'modified' },
      { path: 'new.txt', added: null, removed: null, status: 'untracked' },
    ]));
    expect(JSON.stringify(result)).not.toContain(opts.homeDir);

    await writeFile(join(opts.runsDir, 'RQ-VALID.base'), `${validBase} branch ${opts.repo}\n`);
    const valid = await getFleetJobChanges('RQ-VALID', { ...opts, runner });
    expect(valid.state).toBe('live');
    expect(valid.baseSha).toBe(validBase);
    expect(valid).not.toHaveProperty('comparisonBase');
    expect(valid.files).toEqual(result.files);
  });

  it('uses one bounded fallback and filters unsafe paths', async () => {
    const opts = await setup();
    const runner = vi.fn<GitRunner>(async (_bin, args) => {
      if (args[0] === 'status') return ok('? new.txt\0? ../escape\0');
      if (args[3] === stale) return { ...ok(), code: 128, stderr: `fatal: bad revision '${stale}'\n` };
      return ok('1\t0\ttracked.txt\0' + '2\t0\t../escape\0');
    });
    const result = await getFleetJobChanges('RQ-TEST', { ...opts, runner });
    expect(result).toMatchObject({ state: 'degraded', baseSha: stale, comparisonBase: 'HEAD' });
    expect(result.files).toEqual([
      { path: 'tracked.txt', added: 1, removed: 0, status: 'modified' },
      { path: 'new.txt', added: null, removed: null, status: 'untracked' },
    ]);
    const diffs = runner.mock.calls.filter(([, args]) => args[0] === 'diff');
    expect(diffs.map(([, args]) => args[3])).toEqual([stale, 'HEAD']);
    expect(diffs.every(([, , options]) => options.timeoutMs === 5000 && options.maxStdoutBytes === 1048576)).toBe(true);
  });

  it.each([
    ['timeout', { code: null, timedOut: true }],
    ['truncation', { code: null, truncated: true }],
    ['missing git', { code: null, missing: true }],
    ['unrelated git failure', { code: 128, stderr: 'fatal: not a git repository' }],
  ])('does not retry on %s and retains untracked files', async (_name, failure) => {
    const opts = await setup();
    const runner = vi.fn<GitRunner>(async (_bin, args) => args[0] === 'status' ? ok('? new.txt\0') : { ...ok(), ...failure });
    const result = await getFleetJobChanges('RQ-TEST', { ...opts, runner });
    expect(result.state).toBe('degraded');
    expect(result.baseSha).toBe(stale);
    expect(result).not.toHaveProperty('comparisonBase');
    expect(result.files).toEqual([{ path: 'new.txt', added: null, removed: null, status: 'untracked' }]);
    expect(result.truncated).toBe(failure.truncated === true);
    expect(runner.mock.calls.filter(([, args]) => args[0] === 'diff')).toHaveLength(1);
  });

  it('retains untracked files if the fallback also fails', async () => {
    const opts = await setup();
    const runner = vi.fn<GitRunner>(async (_bin, args) => {
      if (args[0] === 'status') return ok('? new.txt\0');
      return args[3] === stale
        ? { ...ok(), code: 128, stderr: `fatal: bad object ${stale}\n` }
        : { ...ok(), code: null, timedOut: true };
    });
    const result = await getFleetJobChanges('RQ-TEST', { ...opts, runner });
    expect(result.state).toBe('degraded');
    expect(result).not.toHaveProperty('comparisonBase');
    expect(result.files).toEqual([{ path: 'new.txt', added: null, removed: null, status: 'untracked' }]);
    expect(runner.mock.calls.filter(([, args]) => args[0] === 'diff')).toHaveLength(2);
  });
});
