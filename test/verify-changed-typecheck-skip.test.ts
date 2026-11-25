import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// End-to-end fixture, same shape as verify-changed-dedupe.test.ts: a real git
// repo holding the real script, stub guard scripts and a fake tsc whose
// observed.txt write proves the typecheck lane ran. The lane must defer to
// the rerun once an earlier check has already failed the tree.

const fixtures: string[] = [];
let template: string;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verify-tskip-'));
  fixtures.push(root);
  cpSync(template, root, { recursive: true });
  return root;
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'verify-tskip-template-'));
  template = root;
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
  writeFileSync(join(root, 'scripts/verify-changed.mjs'), readFileSync(resolve('scripts/verify-changed.mjs')));
  for (const name of ['test-ci.mjs', 'check-realio-lane-membership.mjs', 'check-verse-sync-io.mjs']) {
    writeFileSync(join(root, 'scripts', name), '');
  }
  // Byproducts of a verify run stay out of the tree hash, like real ignored artifacts.
  writeFileSync(join(root, '.gitignore'), '.ashlr-gate/\nnode_modules/\nobserved.txt\nshared/\nmarkers/\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0-test"}');
  writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    fs.writeFileSync('observed.txt', 'compiled');
    fs.mkdirSync('.ashlr-gate/verify', { recursive: true });
    fs.writeFileSync('.ashlr-gate/verify/backend.tsbuildinfo', 'compiled');
  `);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
});

function run(root: string) {
  return spawnSync(process.execPath, ['scripts/verify-changed.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      PHANTOM_TSC_CACHE_DIR: join(root, 'shared'),
      PHANTOM_VERIFY_PASSED_DIR: '',
      PHANTOM_VERIFY_FORCE: '',
    },
  });
}

function writeSource(root: string) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/backend.ts'), 'export {};\n');
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

describe('verify-changed typecheck deferral', () => {
  it('runs the typecheck lane when every earlier check passes', () => {
    const root = fixture();
    writeSource(root);
    const result = run(root);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS tsc --noEmit');
    expect(readFileSync(join(root, 'observed.txt'), 'utf8')).toBe('compiled');
  });

  it('skips the typecheck lane once an earlier check has failed the tree', () => {
    const root = fixture();
    writeSource(root);
    writeFileSync(join(root, 'bad.json'), '{not json');
    const result = run(root);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('FAIL json syntax check');
    expect(result.stdout).toContain('SKIP typecheck: an earlier check failed; fix it and rerun');
    expect(result.stdout).not.toContain('PASS tsc --noEmit');
    expect(existsSync(join(root, 'observed.txt'))).toBe(false);
  });

  it('still prints the skip only when a typecheck was selected', () => {
    const root = fixture();
    writeFileSync(join(root, 'bad.json'), '{not json');
    const result = run(root);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('FAIL json syntax check');
    // A docs/data-only diff selects no typecheck project, so no skip line
    // claims a lane was deferred that never ran.
    expect(result.stdout).not.toContain('SKIP typecheck');
  });
});
