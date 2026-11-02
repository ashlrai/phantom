import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  readVerifyPassed, recordVerifyPassed, verifyDedupeInput, verifyDedupeKey,
  verifyForceRequested, verifyPassedDir, workingTreeHash,
} from '../scripts/verify-changed.mjs';

const fixtures: string[] = [];
let template: string;

// Same fixture shape as verify-changed-tsc-cache.test.ts: a real git repo with
// stub guard scripts and a fake tsc that proves it ran by writing observed.txt.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verify-dedupe-'));
  fixtures.push(root);
  cpSync(template, root, { recursive: true });
  return root;
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'verify-dedupe-template-'));
  template = root;
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
  writeFileSync(join(root, 'scripts/verify-changed.mjs'), readFileSync(resolve('scripts/verify-changed.mjs')));
  for (const name of ['check-realio-lane-membership.mjs', 'check-verse-sync-io.mjs']) {
    writeFileSync(join(root, 'scripts', name), '');
  }
  // Byproducts of a verify run stay out of the tree hash, like real ignored artifacts.
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nobserved.txt\nshared/\nmarkers/\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { tsBuildInfoFile: 'node_modules/.cache/backend.tsbuildinfo' } }));
  writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0-test"}');
  writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    const path = require('node:path');
    if (process.env.FAKE_MODE === 'fail') process.exit(2);
    fs.writeFileSync('observed.txt', 'compiled');
    fs.mkdirSync(path.dirname('node_modules/.cache/backend.tsbuildinfo'), { recursive: true });
    fs.writeFileSync('node_modules/.cache/backend.tsbuildinfo', 'compiled');
  `);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
});

function run(root: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['scripts/verify-changed.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      PHANTOM_TSC_CACHE_DIR: join(root, 'shared'),
      PHANTOM_VERIFY_PASSED_DIR: '',
      PHANTOM_VERIFY_FORCE: '',
      ...env,
    },
  });
}

const markerDir = (root: string) => join(root, '.git/phantom-verify-passed');

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

describe('verifyForceRequested bypass flag', () => {
  it('is set by --force on argv and by truthy PHANTOM_VERIFY_FORCE', () => {
    expect(verifyForceRequested([], {})).toBe(false);
    expect(verifyForceRequested(['--force'], {})).toBe(true);
    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(verifyForceRequested([], { PHANTOM_VERIFY_FORCE: value })).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'anything']) {
      expect(verifyForceRequested([], { PHANTOM_VERIFY_FORCE: value })).toBe(false);
    }
  });
});

describe('verifyDedupeKey', () => {
  const input = { base: 'a'.repeat(40), tree: 'b'.repeat(40), eslint: '9.0.0', typescript: '5.0.0', tsgo: false, node: 'v26.0.0', platform: 'darwin' };
  it('is stable for identical input and sensitive to every field', () => {
    expect(verifyDedupeKey(input)).toBe(verifyDedupeKey({ ...input }));
    expect(verifyDedupeKey(input)).toMatch(/^[a-f0-9]{64}$/);
    for (const key of Object.keys(input)) {
      const changed = { ...input, [key]: key === 'tsgo' ? true : `${input[key as keyof typeof input]}-x` };
      expect(verifyDedupeKey(changed)).not.toBe(verifyDedupeKey(input));
    }
  });
});

describe('passed-marker store', () => {
  it('round-trips a record and misses on absent, corrupt or mismatched keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-passed-'));
    fixtures.push(dir);
    const input = { base: 'a', tree: 'b' };
    const key = verifyDedupeKey(input);
    expect(readVerifyPassed(dir, key)).toBeNull();
    const target = recordVerifyPassed(dir, input, { key, now: () => 1700000000000 });
    expect(target).toBe(join(dir, `${key}.json`));
    const hit = readVerifyPassed(dir, key);
    expect(hit).toMatchObject({ base: 'a', tree: 'b', key, recordedAt: '2023-11-14T22:13:20.000Z' });
    writeFileSync(join(dir, `${key}.json`), 'not json');
    expect(readVerifyPassed(dir, key)).toBeNull();
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ key: 'other' }));
    expect(readVerifyPassed(dir, key)).toBeNull();
  });

  it('prunes the oldest markers past the cap and never leaves temp siblings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-passed-'));
    fixtures.push(dir);
    const names = ['oldest', 'middle', 'newest'];
    for (const name of names) recordVerifyPassed(dir, { tree: name }, { key: name });
    // Age the first two so pruning order is deterministic.
    utimesSync(join(dir, 'oldest.json'), new Date(0), new Date(0));
    utimesSync(join(dir, 'middle.json'), new Date(1000), new Date(1000));
    recordVerifyPassed(dir, { tree: 'fourth' }, { key: 'fourth', cap: 3 });
    expect(readdirSync(dir).sort()).toEqual(['fourth.json', 'middle.json', 'newest.json']);
    expect(readdirSync(dir).every((name) => !name.endsWith('.tmp'))).toBe(true);
  });
});

describe('workingTreeHash', () => {
  it('equals HEAD^{tree} on a clean checkout and tracks unstaged, staged and untracked edits', () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const clean = workingTreeHash(root);
    expect(clean).toBe(git('rev-parse', 'HEAD^{tree}'));
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    const dirty = workingTreeHash(root);
    expect(dirty).not.toBe(clean);
    git('add', 'package-lock.json');
    expect(workingTreeHash(root)).toBe(dirty);
    writeFileSync(join(root, 'untracked file.ts'), 'export {};\n');
    expect(workingTreeHash(root)).not.toBe(dirty);
  });

  it('leaves the real index and worktree untouched', () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'staged.ts'), 'export {};\n');
    git('add', 'staged.ts');
    writeFileSync(join(root, 'dirty.ts'), 'export {};\n');
    const before = readFileSync(join(root, '.git/index'));
    workingTreeHash(root);
    expect(readFileSync(join(root, '.git/index'))).toEqual(before);
    expect(git('status', '--porcelain')).toBe('A  staged.ts\n?? dirty.ts');
  });
});

describe('verifyDedupeInput', () => {
  it('captures base, tree, checker identities and platform', () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const input = verifyDedupeInput(root);
    expect(input.base).toBe(git('rev-parse', 'HEAD'));
    expect(input.tree).toBe(git('rev-parse', 'HEAD^{tree}'));
    expect(input.eslint).toBe('');
    expect(input.typescript).toBe('0.0.0-test');
    expect(input.tsgo).toBe(false);
    expect(input.node).toBe(process.version);
    expect(input.platform).toBe(process.platform);
  });
});

describe('verifyPassedDir', () => {
  it('defaults under the git common dir and honors PHANTOM_VERIFY_PASSED_DIR', () => {
    const root = fixture();
    expect(verifyPassedDir(root)).toBe(join(root, '.git/phantom-verify-passed'));
    expect(verifyPassedDir(root, { PHANTOM_VERIFY_PASSED_DIR: '/elsewhere' })).toBe('/elsewhere');
  });
});

describe('verify-changed dedupe end-to-end', () => {
  it('records a pass marker and skips an identical rerun without invoking checks', () => {
    const root = fixture();
    const first = run(root);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('PASS verify dedupe: recorded tree');
    expect(readFileSync(join(root, 'observed.txt'), 'utf8')).toBe('compiled');
    const markers = readdirSync(markerDir(root));
    expect(markers).toHaveLength(1);
    expect(readFileSync(join(markerDir(root), markers[0]), 'utf8')).toContain('"recordedAt"');

    rmSync(join(root, 'observed.txt'));
    const second = run(root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('SKIP verify-changed: tree');
    expect(second.stdout).toContain('--force');
    expect(second.stdout).not.toContain('PASS file selection');
    expect(existsSync(join(root, 'observed.txt'))).toBe(false);
  }, 120_000);

  it('reruns when the tree, the merge-base or the checker install moves', () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    expect(run(root).status).toBe(0);
    writeFileSync(join(root, 'notes.md'), 'edit\n');
    const dirty = run(root);
    expect(dirty.status).toBe(0);
    expect(dirty.stdout).toContain('PASS file selection');
    // Committing the edit leaves the tree hash identical; only the base moves.
    git('add', 'notes.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'bump');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const rebased = run(root);
    expect(rebased.status).toBe(0);
    expect(rebased.stdout).toContain('PASS file selection');
    mkdirSync(join(root, 'node_modules/eslint/bin'), { recursive: true });
    mkdirSync(join(root, 'node_modules/eslint/lib'), { recursive: true });
    writeFileSync(join(root, 'node_modules/eslint/package.json'), '{"name":"eslint","version":"9.0.0"}');
    writeFileSync(join(root, 'node_modules/eslint/bin/eslint.js'), 'process.exit(0);\n');
    writeFileSync(join(root, 'node_modules/eslint/lib/cli.js'), '');
    const eslinted = run(root);
    expect(eslinted.status).toBe(0);
    expect(eslinted.stdout).toContain('PASS file selection');
  }, 120_000);

  it('keeps --force and PHANTOM_VERIFY_FORCE as bypass flags that still record', () => {
    const root = fixture();
    expect(run(root).status).toBe(0);
    rmSync(join(root, 'observed.txt'));
    const forced = run(root, ['--force']);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('PASS file selection');
    expect(existsSync(join(root, 'observed.txt'))).toBe(true);
    rmSync(join(root, 'observed.txt'));
    const envForced = run(root, [], { PHANTOM_VERIFY_FORCE: '1' });
    expect(envForced.status).toBe(0);
    expect(envForced.stdout).toContain('PASS file selection');
    expect(readdirSync(markerDir(root))).toHaveLength(1);
  }, 120_000);

  it('never records a failing run and treats a corrupt marker as a miss', () => {
    const root = fixture();
    expect(run(root, [], { FAKE_MODE: 'fail' }).status).not.toBe(0);
    expect(existsSync(markerDir(root))).toBe(false);
    expect(run(root).status).toBe(0);
    const key = verifyDedupeKey(verifyDedupeInput(root));
    writeFileSync(join(markerDir(root), `${key}.json`), 'not json');
    const rerun = run(root);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain('PASS file selection');
  }, 120_000);

  it('honors PHANTOM_VERIFY_PASSED_DIR relocation', () => {
    const root = fixture();
    const elsewhere = join(root, 'markers');
    expect(run(root, [], { PHANTOM_VERIFY_PASSED_DIR: elsewhere }).status).toBe(0);
    expect(readdirSync(elsewhere)).toHaveLength(1);
    expect(existsSync(markerDir(root))).toBe(false);
    const second = run(root, [], { PHANTOM_VERIFY_PASSED_DIR: elsewhere });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('SKIP verify-changed');
  }, 120_000);
});
