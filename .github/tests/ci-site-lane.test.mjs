import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { classifyDocsLane, classifyLane, classifySiteLane, isDocsOnlyPath, SITE_ONLY_PATHS } from '../scripts/ci-site-lane.mjs';

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

function docsFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'phantom-docs-lane-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'CI Docs Lane');
  git(cwd, 'config', 'user.email', 'ci-docs-lane@example.invalid');
  for (const path of ['README.md', 'docs/GUIDE.md', 'docs/img/shot.png', 'src/app.ts', 'test/fixtures/note.md']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), 'baseline\n');
  }
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const finish = () => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'candidate');
    return { cwd, base, head: git(cwd, 'rev-parse', 'HEAD'), eventName: 'pull_request' };
  };
  return { cwd, finish, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('docs-only path patterns', () => {
  for (const path of ['README.md', 'CHANGELOG.md', 'docs/GUIDE.md', 'docs/a/b.png', 'site/notes.md']) {
    assert.equal(isDocsOnlyPath(path), true, path);
  }
  for (const path of ['src/a.ts', 'src/notes.md', 'test/fixtures/x.md', '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/workflows/ci.yml', 'package.json', 'CODEOWNERS', 'README.md.ts', 'scripts/x.md']) {
    assert.equal(isDocsOnlyPath(path), false, path);
  }
});

test('Markdown and docs/ edits, additions, and deletions take the docs lane', () => {
  for (const change of [
    (cwd) => writeFileSync(join(cwd, 'README.md'), 'changed\n'),
    (cwd) => { writeFileSync(join(cwd, 'docs/GUIDE.md'), 'changed\n'); writeFileSync(join(cwd, 'docs/NEW.md'), 'new\n'); },
    (cwd) => rmSync(join(cwd, 'docs/img/shot.png')),
  ]) {
    const work = docsFixture();
    try {
      change(work.cwd);
      const candidate = work.finish();
      assert.equal(classifyDocsLane(candidate), 'docs');
      assert.equal(classifyLane(candidate), 'docs');
    } finally { work.cleanup(); }
  }
});

test('any code, test fixture, or mode change keeps full CI', () => {
  for (const change of [
    (cwd) => writeFileSync(join(cwd, 'src/app.ts'), 'export {};\n'),
    (cwd) => writeFileSync(join(cwd, 'test/fixtures/note.md'), 'changed\n'),
    (cwd) => chmodSync(join(cwd, 'docs/GUIDE.md'), 0o755),
    (cwd) => { rmSync(join(cwd, 'docs/GUIDE.md')); symlinkSync('../README.md', join(cwd, 'docs/GUIDE.md')); },
  ]) {
    const work = docsFixture();
    try {
      writeFileSync(join(work.cwd, 'README.md'), 'changed\n');
      change(work.cwd);
      assert.equal(classifyLane(work.finish()), 'full');
    } finally { work.cleanup(); }
  }
});

test('non-PR events never take the docs lane', () => {
  for (const eventName of ['push', 'merge_group', 'schedule', 'workflow_call']) {
    assert.equal(classifyDocsLane({ eventName }), 'full');
    assert.equal(classifyLane({ eventName }), 'full');
  }
});
