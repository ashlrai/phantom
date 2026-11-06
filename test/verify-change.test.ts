import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { changeCommands, changeHandoff, verifyChange } from '../src/core/verify-change.js';
import { cmdVerify } from '../src/cli/verify.js';
const roots: string[] = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'verify-change-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [name, text] of Object.entries({ 'baseline.txt': 'baseline', ...files })) writeFileSync(join(root, name), text);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('worktree change verification', () => {
  it('prefers CI scripts and package manager metadata over lockfile hints', () => {
    const root = fixture({ 'package.json': JSON.stringify({ packageManager: 'pnpm@10.28.2', scripts: { 'test:ci': 'true', test: 'false', typecheck: 'true', lint: 'true' } }), 'bun.lock': '' });
    expect(changeCommands(root)).toEqual({ typecheck: ['pnpm', 'run', 'typecheck'], unit: ['pnpm', 'run', 'test:ci'], lint: ['pnpm', 'run', 'lint'] });
  });
  it.each(['bun.lock', 'bun.lockb', 'pnpm-lock.yaml'])('detects %s', (lock) => {
    const root = fixture({ 'package.json': '{"scripts":{"test":"true"}}', [lock]: '' });
    expect(changeCommands(root).unit?.[0]).toBe(lock.startsWith('bun') ? 'bun' : 'pnpm');
  });
  it.each([
    ['Cargo.toml', 'cargo', 'test'], ['pyproject.toml', 'python', '-m'], ['go.mod', 'go', 'test'],
  ])('detects native toolchain %s', (manifest, bin, arg) => {
    expect(changeCommands(fixture({ [manifest]: '' })).unit?.slice(0, 2)).toEqual([bin, arg]);
  });
  it('runs actual scripts, gathers staged, deleted and untracked files, and withholds output', async () => {
    const root = fixture({ 'package.json': JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', test: 'node -e "console.error(process.env.HOME);process.exit(1)"' } }) });
    rmSync(join(root, 'baseline.txt'));
    writeFileSync(join(root, 'new file.txt'), 'new');
    writeFileSync(join(root, 'staged.txt'), 'staged');
    execFileSync('git', ['add', 'staged.txt'], { cwd: root });
    const verdict = verifyChange(root, ['typecheck', 'unit']);
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.map((c) => c.ok)).toEqual([true, false]);
    expect(verdict.changed_files).toEqual(['baseline.txt', 'new file.txt', 'staged.txt']);
    expect(JSON.stringify(verdict)).not.toContain(process.env.HOME);
    expect(changeHandoff(verdict).split('\n')).toHaveLength(10);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdVerify(['change', '--worktree', root, '--checks', 'typecheck'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]?.[0])).pass).toBe(true);
    expect(await cmdVerify(['change', '--worktree', root, '--checks', 'unit'])).toBe(1);
    expect(await cmdVerify(['change', '--worktree', root, '--checks', 'unknown'])).toBe(2);
  });
  it('prefers native CI check arguments without running setup or deployment steps', () => {
    const root = fixture({ 'go.mod': '' });
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  checks:\n    steps:\n      - run: go test -race ./...\n      - run: echo deploy\n');
    expect(changeCommands(root).unit).toEqual(['go', 'test', '-race', './...']);
  });
  it('fails closed for absent checks and invalid repos', () => {
    expect(verifyChange(fixture({}), ['secrets']).pass).toBe(false);
    expect(() => verifyChange('/nonexistent/verify-change')).toThrow();
  });
  it('uses the unchanged secret gate and scans untracked additions', () => {
    const root = fixture({});
    mkdirSync(join(root, '.github/tests/secret-shape'), { recursive: true });
    copyFileSync(resolve('.github/tests/secret-shape/scrub.pl'), join(root, '.github/tests/secret-shape/scrub.pl'));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'gate'], { cwd: root });
    expect(verifyChange(root, ['secrets']).pass).toBe(true);
    writeFileSync(join(root, 'credential.txt'), ['ghp_', 'A'.repeat(36)].join(''));
    const result = verifyChange(root, ['secrets']);
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result)).not.toContain('A'.repeat(36));
  });
});
