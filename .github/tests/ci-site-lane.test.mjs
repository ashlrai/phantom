import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { classifyMacLane, classifySiteLane, SITE_ONLY_PATHS } from '../scripts/ci-site-lane.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'phantom-site-lane-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'CI Site Lane');
  git(cwd, 'config', 'user.email', 'ci-site-lane@example.invalid');
  for (const path of SITE_ONLY_PATHS) {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'baseline\n');
  }
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const finish = () => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'candidate');
    const head = git(cwd, 'rev-parse', 'HEAD');
    return { cwd, base, head, eventName: 'pull_request' };
  };
  return { cwd, base, finish, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('only modifications of the exact ecosystem allowlist use the site lane', () => {
  const work = fixture();
  try {
    for (const path of SITE_ONLY_PATHS) writeFileSync(join(work.cwd, path), 'changed\n');
    assert.equal(classifySiteLane(work.finish()), 'site');
  } finally { work.cleanup(); }
});

test('source changes, unknown site files, and deletions use full CI', () => {
  for (const change of [
    (cwd) => { mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'src/app.ts'), 'export {};\n'); },
    (cwd) => writeFileSync(join(cwd, 'site/other.html'), 'new\n'),
    (cwd) => rmSync(join(cwd, 'site/ecosystem.html')),
  ]) {
    const work = fixture();
    try {
      writeFileSync(join(work.cwd, SITE_ONLY_PATHS[1]), 'changed\n');
      change(work.cwd);
      assert.equal(classifySiteLane(work.finish()), 'full');
    } finally { work.cleanup(); }
  }
});

test('mode changes use full CI even for allowed names', () => {
  const work = fixture();
  try {
    chmodSync(join(work.cwd, SITE_ONLY_PATHS[1]), 0o755);
    assert.equal(classifySiteLane(work.finish()), 'full');
  } finally { work.cleanup(); }
});

test('pushes and reusable calls always use full CI', () => {
  assert.equal(classifySiteLane({ eventName: 'push' }), 'full');
  assert.equal(classifySiteLane({ eventName: 'workflow_call' }), 'full');
});

test('missing or mismatched PR identity fails the classifier', () => {
  const work = fixture();
  try {
    writeFileSync(join(work.cwd, SITE_ONLY_PATHS[0]), 'changed\n');
    const candidate = work.finish();
    assert.throws(() => classifySiteLane({ ...candidate, base: 'bad' }), /exact commit SHAs/);
    assert.throws(() => classifySiteLane({ ...candidate, head: candidate.base }), /checkout does not match/);
  } finally { work.cleanup(); }
});

function macLane(change) {
  const work = fixture();
  try {
    change(work.cwd);
    return classifyMacLane(work.finish());
  } finally { work.cleanup(); }
}
const put = (cwd, path, text = 'x\n') => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};

test('docs-only and site-only PRs skip the Mac jobs', () => {
  assert.equal(macLane((cwd) => put(cwd, 'README.md')), 'skip');
  assert.equal(macLane((cwd) => put(cwd, 'docs/guide/a.md')), 'skip');
  assert.equal(macLane((cwd) => put(cwd, 'site/index.html')), 'skip');
  assert.equal(macLane((cwd) => { put(cwd, 'docs/a.md'); put(cwd, 'site/assets/x.css'); }), 'skip');
  assert.equal(macLane((cwd) => rmSync(join(cwd, 'site/ecosystem.html'))), 'skip');
});

test('anything else keeps the Mac jobs', () => {
  for (const path of ['src/app.ts', 'test/a.test.ts', 'package.json', 'package-lock.json',
    '.github/workflows/ci.yml', '.github/CODEOWNERS', 'native/x.rs', 'scripts/a.mjs', 'docs/tool.mjs', 'site/a.sh']) {
    assert.equal(macLane((cwd) => { put(cwd, 'README.md'); put(cwd, path); }), 'run', path);
  }
});

test('mode changes and symlinks in docs keep the Mac jobs', () => {
  assert.equal(macLane((cwd) => chmodSync(join(cwd, SITE_ONLY_PATHS[1]), 0o755)), 'run');
  assert.equal(macLane((cwd) => symlinkSync('/etc/passwd', join(cwd, 'NOTES.md'))), 'run');
});

test('non-PR events and empty diffs keep the Mac jobs', () => {
  assert.equal(classifyMacLane({ eventName: 'push' }), 'run');
  assert.equal(classifyMacLane({ eventName: 'merge_group' }), 'run');
  assert.equal(classifyMacLane({ eventName: 'workflow_call' }), 'run');
});
