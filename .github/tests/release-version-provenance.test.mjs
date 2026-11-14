import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPullRequest, judgeVersionProvenance, versionCarriers } from '../scripts/release-version-provenance.mjs';

const at = (version, manifest = version) => ({ version, manifest });
const releasePlease = 'release-please--branches--master--components--phantom';

test('unchanged version carriers pass from any branch', () => {
  assert.deepEqual(judgeVersionProvenance({ base: at('3.30.31'), head: at('3.30.31'), headRef: 'codex-bridge/RQ-X', headRepository: 'masonwyatt23/phantom' }),
    { ok: true, reason: 'version-unchanged', changed: [] });
});

test('the release-please PR in the canonical repository may bump the version', () => {
  const verdict = judgeVersionProvenance({ base: at('3.30.32'), head: at('3.30.33'), headRef: releasePlease, headRepository: 'ashlrai/phantom' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'release-please-pr');
});

test('a bridge hand bump is refused: #4735 RQ-UPKEEP-REL release 3.30.32', () => {
  const verdict = judgeVersionProvenance({
    base: at('3.30.31'), head: at('3.30.32'),
    headRef: 'codex-bridge/RQ-UPKEEP-REL-phantom-20261110', headRepository: 'masonwyatt23/phantom',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'version-bump-outside-release-please');
  assert.deepEqual(verdict.changed, ['package.json version 3.30.31 -> 3.30.32', '.release-please-manifest.json "." 3.30.31 -> 3.30.32']);
});

test('a release-please-looking branch name is not enough without the canonical repository', () => {
  for (const headRepository of ['masonwyatt23/phantom', undefined, '']) {
    assert.equal(judgeVersionProvenance({ base: at('1.0.0'), head: at('1.0.1'), headRef: releasePlease, headRepository }).ok, false);
  }
  for (const headRef of ['codex-bridge/release-please--x', 'release-please', undefined]) {
    assert.equal(judgeVersionProvenance({ base: at('1.0.0'), head: at('1.0.1'), headRef, headRepository: 'ashlrai/phantom' }).ok, false);
  }
});

test('either carrier alone counts as a bump, including removal', () => {
  assert.equal(judgeVersionProvenance({ base: at('1.0.0'), head: at('1.0.0', '1.0.1'), headRef: 'feature', headRepository: 'ashlrai/phantom' }).ok, false);
  assert.equal(judgeVersionProvenance({ base: at('1.0.0'), head: at('1.0.1', '1.0.0'), headRef: 'feature', headRepository: 'ashlrai/phantom' }).ok, false);
  assert.equal(judgeVersionProvenance({ base: at('1.0.0'), head: at(null, null), headRef: 'feature', headRepository: 'ashlrai/phantom' }).ok, false);
  assert.deepEqual(versionCarriers(null, null), { version: null, manifest: null });
  assert.deepEqual(versionCarriers('{"version":"1.2.3"}', '{".":"1.2.3"}'), { version: '1.2.3', manifest: '1.2.3' });
});

test('git checkout: compares the merge base with the PR head and rejects bad identities', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'version-provenance-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (version) => {
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({ name: '@ashlr/phantom', version, scripts: { a: 'b' } }, null, 2)}\n`);
    writeFileSync(join(cwd, '.release-please-manifest.json'), `${JSON.stringify({ '.': version }, null, 2)}\n`);
  };
  try {
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 'CI');
    git('config', 'user.email', 'ci@example.invalid');
    write('3.30.31');
    git('add', '.'); git('commit', '-qm', 'chore(master): release 3.30.31 (#4613)');
    const base = git('rev-parse', 'HEAD');
    // A script-only package.json edit is not a version bump.
    writeFileSync(join(cwd, 'package.json'), readFileSync(join(cwd, 'package.json'), 'utf8').replace('"b"', '"c"'));
    git('commit', '-qam', 'bridge(RQ-X): scripts');
    const scripts = git('rev-parse', 'HEAD');
    assert.equal(checkPullRequest({ cwd, base, head: scripts, headRef: 'codex-bridge/RQ-X', headRepository: 'masonwyatt23/phantom' }).ok, true);
    write('3.30.32');
    git('commit', '-qam', 'bridge(RQ-UPKEEP-REL-phantom-20261110): release 3.30.32');
    const bump = git('rev-parse', 'HEAD');
    // master moved on after the branch point: the merge base is still the reference.
    git('checkout', '-q', '-b', 'later', base);
    writeFileSync(join(cwd, 'other.txt'), 'x\n');
    git('add', '.'); git('commit', '-qm', 'later');
    const movedBase = git('rev-parse', 'HEAD');
    assert.equal(checkPullRequest({ cwd, base: movedBase, head: bump, headRef: 'codex-bridge/RQ-UPKEEP-REL-phantom-20261110', headRepository: 'masonwyatt23/phantom' }).ok, false);
    assert.equal(checkPullRequest({ cwd, base: movedBase, head: bump, headRef: releasePlease, headRepository: 'ashlrai/phantom' }).ok, true);
    assert.throws(() => checkPullRequest({ cwd, base: 'bad', head: bump }), /exact commit SHAs/);
    assert.throws(() => checkPullRequest({ cwd, base, head: undefined }), /exact commit SHAs/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CI runs the provenance check on pull requests with untrusted values passed through env', () => {
  const ci = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const step = ci.slice(ci.indexOf('- name: Require release-please provenance for version bumps'));
  assert.ok(step.length > 0 && ci.includes('- name: Require release-please provenance for version bumps'));
  const block = step.slice(0, step.indexOf('\n      - name:', 10) === -1 ? undefined : step.indexOf('\n      - name:', 10));
  assert.match(block, /if: github\.event_name == 'pull_request'/);
  assert.match(block, /HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  assert.match(block, /HEAD_REPOSITORY: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/);
  assert.match(block, /node \.github\/scripts\/release-version-provenance\.mjs/);
  // Branch names are attacker-controlled: never interpolate them into the script body.
  assert.doesNotMatch(block.slice(block.indexOf('run:')), /\$\{\{/);
});
