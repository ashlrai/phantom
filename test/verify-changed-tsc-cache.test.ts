import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verify-tsc-cache-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
  writeFileSync(join(root, 'scripts/verify-changed.mjs'), readFileSync(resolve('scripts/verify-changed.mjs')));
  for (const name of ['check-realio-lane-membership.mjs', 'check-verse-sync-io.mjs']) {
    writeFileSync(join(root, 'scripts', name), '');
  }
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { tsBuildInfoFile: 'node_modules/.cache/backend.tsbuildinfo' } }));
  writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    const path = require('node:path');
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--noEmit', '-p', 'tsconfig.json'])) process.exit(8);
    const file = 'node_modules/.cache/backend.tsbuildinfo';
    if (process.env.FAKE_MODE === 'timeout') setInterval(() => {}, 1000);
    else {
      const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'cold';
      fs.writeFileSync('observed.txt', previous);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, process.env.FAKE_CONTENT || 'compiled');
      if (process.env.FAKE_MODE === 'fail') process.exit(2);
    }
  `);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  return root;
}

function run(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['scripts/verify-changed.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, PHANTOM_TSC_CACHE_DIR: join(root, 'shared'), PHANTOM_TSC_TIMEOUT_SECONDS: '60', ...env },
  });
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('verify-changed TypeScript cache', () => {
  it('publishes a cold result and restores it for the next run', () => {
    const root = fixture();
    expect(run(root).status).toBe(0);
    expect(readFileSync(join(root, 'observed.txt'), 'utf8')).toBe('cold');
    const shared = join(root, 'shared', readdirSync(join(root, 'shared'))[0]);
    expect(readFileSync(shared, 'utf8')).toBe('compiled');
    rmSync(join(root, 'node_modules/.cache/backend.tsbuildinfo'));
    expect(run(root, { FAKE_CONTENT: 'updated' }).status).toBe(0);
    expect(readFileSync(join(root, 'observed.txt'), 'utf8')).toBe('compiled');
    expect(readFileSync(shared, 'utf8')).toBe('updated');
  }, 120_000);

  it('does not publish failed compiler output over the shared cache', () => {
    const root = fixture();
    expect(run(root).status).toBe(0);
    const shared = join(root, 'shared', readdirSync(join(root, 'shared'))[0]);
    const failed = run(root, { FAKE_MODE: 'fail', FAKE_CONTENT: 'failed' });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toContain('FAIL tsc --noEmit');
    expect(readFileSync(shared, 'utf8')).toBe('compiled');
  }, 120_000);

  it('fails visibly on timeout and does not publish compiler output', () => {
    const root = fixture();
    const result = run(root, { FAKE_MODE: 'timeout', PHANTOM_TSC_TIMEOUT_SECONDS: '0.3' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('FAIL tsc timed out after 0.3s');
    expect(existsSync(join(root, 'shared'))).toBe(false);
  }, 120_000);

  it('uses the git common directory by default and keys both inputs', () => {
    const root = fixture();
    expect(run(root, { PHANTOM_TSC_CACHE_DIR: '' }).status).toBe(0);
    const shared = join(root, '.git/phantom-tsc-cache');
    expect(readdirSync(shared)).toHaveLength(1);
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion": 3}');
    expect(run(root, { PHANTOM_TSC_CACHE_DIR: '' }).status).toBe(0);
    expect(readdirSync(shared)).toHaveLength(2);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { tsBuildInfoFile: 'node_modules/.cache/backend.tsbuildinfo', strict: true } }));
    expect(run(root, { PHANTOM_TSC_CACHE_DIR: '' }).status).toBe(0);
    expect(readdirSync(shared)).toHaveLength(3);
  }, 120_000);
});
