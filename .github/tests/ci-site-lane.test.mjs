/* global process, URL */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { classifySiteLane, documentationPlan, documentationReaderInventory, DOCUMENTATION_POLICY_INPUTS, DOCUMENTATION_ONLY_PATHS, SITE_ONLY_PATHS } from '../scripts/ci-site-lane.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'phantom-site-lane-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'CI Site Lane');
  git(cwd, 'config', 'user.email', 'ci-site-lane@example.invalid');
  git(cwd, 'config', 'maintenance.auto', 'false');
  git(cwd, 'config', 'gc.auto', '0');
  for (const path of [...SITE_ONLY_PATHS, ...DOCUMENTATION_ONLY_PATHS]) {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'baseline\n');
  }
  for (const path of DOCUMENTATION_POLICY_INPUTS) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), 'inert policy fixture\n');
  }
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts/reader.js'), 'export const reader = 0;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const reviewedReaderDigest = documentationReaderInventory(cwd, base).digest;
  const finish = () => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'candidate');
    const head = git(cwd, 'rev-parse', 'HEAD');
    return { cwd, base, head, eventName: 'pull_request', reviewedReaderDigest };
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

test('only reviewed public prose modifications select documentation PR feedback', () => {
  const work = fixture();
  try {
    for (const path of DOCUMENTATION_ONLY_PATHS) writeFileSync(join(work.cwd, path), '# Guide updated\n');
    const candidate = work.finish();
    assert.equal(classifySiteLane(candidate), 'documentation');
    const plan = documentationPlan(candidate);
    assert.equal(plan.releaseEligible, false); assert.equal(plan.head, candidate.head);
    assert.deepEqual(plan.changes.map((row) => row.path), [...DOCUMENTATION_ONLY_PATHS].sort());
    assert.ok(plan.changes.every((row) => row.baseBlob !== row.headBlob));
    assert.equal(classifySiteLane({ ...candidate, eventName: 'workflow_call' }), 'full');
    assert.equal(classifySiteLane({ ...candidate, eventName: 'push' }), 'full');
    assert.throws(() => documentationPlan({ ...candidate, eventName: 'push' }), /documentation-only/);
  } finally { work.cleanup(); }
});

for (const path of ['AGENTS.md', 'README.md', 'CHANGELOG.md', 'docs/COMPANIONS.md', 'docs/AUTHORITY.md',
  'docs/LOCALITY-VS-SPEND.md', 'docs/VERSE-CONTEXT.md', 'docs/RELEASING.md', 'docs/contracts/NEW.md',
  'src/core/example.ts', 'desktop/new.rs', 'package.json', '.github/workflows/new.yml', 'site/ecosystem.html', ...DOCUMENTATION_POLICY_INPUTS]) {
  test(`mixed or unreviewed ${path} selects full qualification`, () => {
    const work = fixture();
    try {
      writeFileSync(join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]), '# Changed\n');
      mkdirSync(dirname(join(work.cwd, path)), { recursive: true }); writeFileSync(join(work.cwd, path), 'changed\n');
      assert.equal(classifySiteLane(work.finish()), 'full');
    } finally { work.cleanup(); }
  });
}

for (const kind of ['executable', 'symlink', 'deleted', 'renamed', 'new-path']) {
  test(`documentation ${kind} cannot select a fast lane`, () => {
    const work = fixture();
    try {
      const path = join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]);
      if (kind === 'executable') chmodSync(path, 0o755);
      if (kind === 'symlink') { rmSync(path); symlinkSync('DEMO.md', path); }
      if (kind === 'deleted') rmSync(path);
      if (kind === 'renamed') renameSync(path, join(work.cwd, 'docs/unreviewed.md'));
      if (kind === 'new-path') writeFileSync(join(work.cwd, 'docs/new-guide.md'), '# New\n');
      assert.equal(classifySiteLane(work.finish()), 'full');
    } finally { work.cleanup(); }
  });
}

test('documentation planning refuses dirty state and an unavailable or mismatched base/head', () => {
  const work = fixture();
  try {
    writeFileSync(join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]), '# Changed\n');
    const candidate = work.finish();
    assert.throws(() => documentationPlan({ ...candidate, base: '0'.repeat(40) }));
    assert.throws(() => documentationPlan({ ...candidate, head: candidate.base }), /checkout/);
    writeFileSync(join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]), '# Dirty\n');
    assert.throws(() => documentationPlan(candidate), /dirty/);
  } finally { work.cleanup(); }
});

for (const kind of ['new-explicit-reader', 'changed-reader', 'generic-reader', 'reader-mode']) {
  test(`later ${kind} invalidates the audited input inventory for a prose-only successor`, () => {
    const work = fixture();
    try {
      const reader = join(work.cwd, kind === 'changed-reader' || kind === 'reader-mode' ? 'scripts/reader.js' : 'scripts/new-reader.js');
      if (kind === 'reader-mode') chmodSync(reader, 0o755);
      else writeFileSync(reader, kind === 'generic-reader' ? 'readFileSync(join(root, "docs", name));\n' : 'readFileSync("docs/DEMO.md");\n');
      git(work.cwd, 'add', '.'); git(work.cwd, 'commit', '-qm', 'new reader baseline');
      const base = git(work.cwd, 'rev-parse', 'HEAD');
      writeFileSync(join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]), '# Prose only\n');
      const candidate = { ...work.finish(), base };
      assert.equal(classifySiteLane(candidate), 'full');
      assert.throws(() => documentationPlan(candidate), /documentation-only/);
    } finally { work.cleanup(); }
  });
}

test('missing, invalid or unknown reviewed inventory selects full rather than guessing', () => {
  const work = fixture();
  try {
    writeFileSync(join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]), '# Updated\n');
    const candidate = work.finish();
    for (const reviewedReaderDigest of ['', 'bad', '0'.repeat(64)]) assert.equal(classifySiteLane({ ...candidate, reviewedReaderDigest }), 'full');
    // A bare production call cannot inherit the private fixture's audited digest.
    const { reviewedReaderDigest: ignored, ...productionInput } = candidate;
    assert.equal(typeof ignored, 'string'); assert.equal(classifySiteLane(productionInput), 'full');
    assert.throws(() => documentationReaderInventory(work.cwd, 'not-a-commit'), /Invalid/);
  } finally { work.cleanup(); }
});

test('production classifier has no fixture digest environment or command-line override', () => {
  const work = fixture();
  try {
    writeFileSync(join(work.cwd, DOCUMENTATION_ONLY_PATHS[0]), '# Updated\n');
    const candidate = work.finish(); const script = fileURLToPath(new URL('../scripts/ci-site-lane.mjs', import.meta.url));
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', ASHLR_CI_BASE_SHA: candidate.base,
      ASHLR_CI_HEAD_SHA: candidate.head, ASHLR_REVIEWED_READER_DIGEST: candidate.reviewedReaderDigest };
    delete env.GITHUB_OUTPUT;
    assert.match(execFileSync(process.execPath, [script], { cwd: work.cwd, env, encoding: 'utf8' }), /CI lane: full/);
    assert.throws(() => execFileSync(process.execPath, [script, `--reader-digest=${candidate.reviewedReaderDigest}`],
      { cwd: work.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally { work.cleanup(); }
});
