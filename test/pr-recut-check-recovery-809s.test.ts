import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPrRecut } from '../src/core/fleet/pr-recut-check.js';
import { cmdFleetRecutCheck } from '../src/cli/fleet-recut-check.js';

const dirs: string[] = [];
beforeEach(() => {
  const gitPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
  vi.stubEnv('PATH', [dirname(gitPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(landed: number) {
  const dir = mkdtempSync(join(tmpdir(), 'recut-test-')); dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 'fake@example.invalid'); git('config', 'user.name', 'Fake');
  writeFileSync(join(dir, 'seed'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'a'), 'first\n'); writeFileSync(join(dir, 'b'), 'second\n');
  git('add', '.'); git('commit', '-qm', 'feature'); const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/42/head', head); git('checkout', '-q', 'master');
  if (landed > 0) {
    writeFileSync(join(dir, 'a'), 'first\n');
    if (landed === 2) writeFileSync(join(dir, 'b'), 'second\n');
    git('add', '.'); git('commit', '-qm', 'landed');
  }
  const gh = async () => ({ ok: true, stdout: JSON.stringify({ number: 42, headRefOid: head, baseRefName: 'master' }), stderr: '' });
  return { dir, head, gh };
}

describe('recut preflight', () => {
  it.each([[2, true, []], [1, false, ['b']], [0, false, ['a', 'b']]] as const)('proves %s landed paths', async (count, expected, remaining) => {
    const f = fixture(count);
    const report = await checkPrRecut(42, 'fake/repo', { gh: f.gh, remote: f.dir });
    expect(report.alreadyOnMaster).toBe(expected);
    expect(report.remainingFiles).toEqual(remaining);
    expect(report.alreadyOnMasterFiles).toEqual(count === 2 ? ['a', 'b'] : count === 1 ? ['a'] : []);
    expect(report.evidence).toMatchObject({ head: f.head, base: 'master', number: 42 });
    expect(report.evidence?.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });
  it('keeps moved and unavailable evidence unknown', async () => {
    const f = fixture(2);
    const moved = await checkPrRecut(42, 'fake/repo', { remote: f.dir, gh: async () => ({ ok: true, stdout: JSON.stringify({ number: 42, headRefOid: 'a'.repeat(40), baseRefName: 'master' }), stderr: '' }) });
    expect(moved).toMatchObject({ alreadyOnMaster: null, remainingFiles: null, evidence: { class: 'unknown', reason: 'head-moved' } });
    const unavailable = await checkPrRecut(42, 'fake/repo', { gh: async () => { throw Error('unavailable'); } });
    expect(unavailable).toMatchObject({ alreadyOnMaster: null, remainingFiles: null });
    expect(unavailable.next).not.toContain('skip');
  });
  it('rejects invalid identity before reads and reports CLI JSON and exit codes', async () => {
    const f = fixture(1); const gh = vi.fn(f.gh);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetRecutCheck(['42', '--repo', 'fake/repo', '--json'], { gh, remote: f.dir })).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0])).remainingFiles).toEqual(['b']);
    gh.mockClear();
    expect(await cmdFleetRecutCheck(['0', '--json'], { gh })).toBe(2);
    expect(await cmdFleetRecutCheck(['42', '--repo', '../bad'], { gh })).toBe(2);
    expect(gh).not.toHaveBeenCalled();
    await expect(checkPrRecut(0, 'fake/repo', { gh })).rejects.toThrow();
    expect(await cmdFleetRecutCheck(['42', '--json'], { gh: async () => ({ ok: false, stdout: '', stderr: '' }) })).toBe(1);
  });
});
