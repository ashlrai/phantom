/** phm self-update --check / --plan over temp git repos: current, behind 3, failed build; --plan writes nothing. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdSelfUpdate } from '../src/cli/self-update.js';
import { parseLiveState } from '../src/core/fleet/build-last.js';
import { readSelfUpdateCheck } from '../src/core/fleet/self-update-check.js';

let dir = '';
let runs = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'self-update-')); runs = mkdtempSync(join(tmpdir(), 'self-update-runs-')); mkdirSync(join(runs, 'leader')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

const git = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const commit = (name: string): void => { writeFileSync(join(dir, name), name); git('add', '.'); git('commit', '-q', '-m', name); };
/** A checkout whose origin/master sits `ahead` commits after the running commit. */
function repo(ahead: number): string {
  git('init', '-q', '-b', 'work');
  commit('first');
  const sha = git('rev-parse', 'HEAD');
  for (let i = 0; i < ahead; i++) commit(`later-${i}`);
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  git('reset', '-q', '--hard', sha);
  return sha;
}
const state = (text: string): void => writeFileSync(join(runs, 'leader', 'phm-live-state.txt'), text);
const check = () => readSelfUpdateCheck({ codeDir: dir, runsDir: runs, now: () => 0, readBuiltSha: () => null });

describe('selfUpdateCheck', () => {
  it('says current when the running commit is master', () => {
    repo(0);
    state('built 2026-11-20T10:00:00Z ok\n');
    const c = check();
    expect(c.verdict).toBe('current');
    expect(c.behind).toBe(0);
    expect(c.running.builtAt).toBe('2026-11-20T10:00:00.000Z');
  });

  it('says behind 3 commits, and names a skipped build', () => {
    repo(3);
    state('build skipped: mem_free_pct=27\n');
    const c = check();
    expect(c.behind).toBe(3);
    expect(c.verdict).toBe('behind 3 commits (last build skipped: build skipped: mem_free_pct=27)');
  });

  it('says the last build failed, in one line', () => {
    repo(3);
    state('2026-11-20T10:00:00Z abcdef1 build ok\n2026-11-20T10:30:00Z build failed: tsc exited 2\n');
    const c = check();
    expect(c.state).toBe('failed');
    expect(c.verdict).toBe('last build failed: 2026-11-20T10:30:00Z build failed: tsc exited 2');
  });

  it('is unknown, not current, without a state file or a master ref', () => {
    git('init', '-q', '-b', 'work'); commit('first');
    const c = check();
    expect(c.state).toBe('unknown');
    expect(c.lastBuild.result).toBe('unknown');
  });
});

describe('parseLiveState', () => {
  it('reads the latest commit, time and result', () => {
    expect(parseLiveState('sha=abc1234 at=2026-11-20T10:00:00Z\nbuilt ok')).toMatchObject({ state: 'known', result: 'ok', sha: 'abc1234', at: '2026-11-20T10:00:00.000Z' });
    expect(parseLiveState('\n')).toMatchObject({ state: 'unknown' });
  });
});

describe('phm self-update', () => {
  it('--check --json prints the typed check', async () => {
    repo(3);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    expect(await cmdSelfUpdate(['--check', '--json'], check)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'self-update.check.v1', behind: 3, state: 'behind' });
  });

  it('--check prints words ending with the verdict', async () => {
    repo(3);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    await cmdSelfUpdate(['--check'], check);
    expect(out.at(-1)).toBe('behind 3 commits');
  });

  it('--plan prints the steps and writes nothing', async () => {
    repo(1);
    const before = [readdirSync(dir).sort(), readdirSync(runs).sort(), git('status', '--porcelain')];
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    const read = vi.fn(check);
    expect(await cmdSelfUpdate(['--plan'], read)).toBe(0);
    expect(out.join('\n')).toMatch(/new directory[\s\S]*Smoke check[\s\S]*symlink[\s\S]*rollback/);
    expect(read).not.toHaveBeenCalled();
    expect([readdirSync(dir).sort(), readdirSync(runs).sort(), git('status', '--porcelain')]).toEqual(before);
  });

  it('rejects bad usage with exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdSelfUpdate([])).toBe(2);
    expect(await cmdSelfUpdate(['--check', '--plan'])).toBe(2);
  });
});
