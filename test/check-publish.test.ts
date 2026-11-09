import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/check-publish.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-check-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'file'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const body = join(dir, 'body.txt');
  writeFileSync(body, 'A clear PR body');
  const run = (...extra: string[]) => spawnSync(process.execPath, [script, '--base', 'HEAD', '--body', body, '--held-path', 'held', ...extra], { cwd: dir, encoding: 'utf8' });
  return { dir, body, git, run };
}

describe('publish preflight', () => {
  it('accepts ordinary changes and lockfiles outside held paths', () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'package-lock.json'), '{}');
    expect(f.run().status).toBe(0);
  });
  it('refuses .github changes', () => {
    const f = fixture();
    mkdirSync(join(f.dir, '.github'));
    writeFileSync(join(f.dir, '.github', 'workflow'), 'x');
    expect(f.run().stderr).toContain('Changed .github path');
    expect(f.run().status).toBe(1);
  });
  it('refuses a lockfile in a held path', () => {
    const f = fixture();
    mkdirSync(join(f.dir, 'held'));
    writeFileSync(join(f.dir, 'held', 'package-lock.json'), '{}');
    expect(f.run().stderr).toContain('Lockfile in held path');
    expect(f.run().status).toBe(1);
  });
  it('refuses an em dash in the proposed body', () => {
    const f = fixture();
    writeFileSync(f.body, 'before\u2014after');
    expect(f.run().stderr).toContain('PR body contains an em dash');
    expect(f.run().status).toBe(1);
  });
  it('reports all refusals and checks committed changes against the merge base', () => {
    const f = fixture();
    f.git('branch', 'base');
    mkdirSync(join(f.dir, '.github'));
    writeFileSync(join(f.dir, '.github', 'x'), 'x');
    mkdirSync(join(f.dir, 'held'));
    writeFileSync(join(f.dir, 'held', 'yarn.lock'), 'x');
    f.git('add', '.github', 'held');
    f.git('commit', '-qm', 'changes');
    writeFileSync(f.body, '\u2014');
    const result = spawnSync(process.execPath, [script, '--base', 'base', '--body', f.body, '--held-path', 'held'], { cwd: f.dir, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Changed .github path');
    expect(result.stderr).toContain('Lockfile in held path');
    expect(result.stderr).toContain('PR body contains an em dash');
  });
  it('fails closed for missing policy inputs and invalid base', () => {
    const f = fixture();
    const missing = spawnSync(process.execPath, [script, '--base', 'HEAD', '--body', f.body], { cwd: f.dir, encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(f.run('--base', 'missing').status).toBe(1);
    const invalid = spawnSync(process.execPath, [script, '--base', 'missing', '--body', f.body, '--no-held-paths'], { cwd: f.dir, encoding: 'utf8' });
    expect(invalid.status).toBe(1);
  });
});
