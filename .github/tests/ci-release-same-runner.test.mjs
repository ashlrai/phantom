import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { URL } from 'node:url';

const workflow = () => parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
test('one real macOS build job preserves the canonical fast-v1 role and all three real evidence steps', () => {
  const jobs = workflow().jobs; assert.equal(jobs['release-smoke'], undefined);
  const job = jobs['release-build']; assert.equal(job.name, 'Desktop release smoke');
  assert.equal(job['runs-on'], 'macos-15'); assert.equal(job['timeout-minutes'], 90);
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  const one = name => { const rows = job.steps.filter(step => step.name === name); assert.equal(rows.length, 1); return rows[0]; };
  assert.equal(one('Verify green master push CI').run, 'node .github/scripts/release-smoke-phase.mjs push');
  assert.equal(one('Smoke desktop release artifact').run, 'node .github/scripts/release-smoke-phase.mjs smoke');
  assert.equal(one('Upload qualified build handoff').uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  assert.equal(one('Upload qualified build handoff').env.NODE_OPTIONS, '--import=${{ github.workspace }}/.github/scripts/release-smoke-upload-deadline.mjs');
  const smoke = one('Smoke desktop release artifact');
  assert.equal(smoke.env.INPUT_ARTIFACT_ID, '${{ steps.artifact.outputs.artifact-id }}');
  assert.equal(smoke.env.INPUT_ARTIFACT_DIGEST, '${{ steps.artifact.outputs.artifact-digest }}');
  const names = job.steps.map(step => step.name);
  assert.ok(names.indexOf('Capture original immutable input custody') < names.indexOf('Upload immutable release input'));
  assert.ok(names.indexOf('Upload immutable release input') < names.indexOf('Start bounded release smoke phase'));
  const phase = job.steps.slice(names.indexOf('Start bounded release smoke phase'));
  assert.equal(phase.at(-1).name, 'Finish bounded release smoke phase');
  assert.ok(phase.every(step => !step['continue-on-error'] && !/npm (ci|install|run build)/.test(step.run ?? '')));
  assert.ok(!names.includes('Download immutable prepared artifact'));
  const reused = one('Download existing immutable build');
  assert.equal(reused.with['artifact-ids'], '${{ steps.existing.outputs.artifact }}');
  assert.equal(reused.with['run-id'], '${{ steps.existing.outputs.run }}');
  assert.equal(reused.with['digest-mismatch'], 'error');
  assert.equal(reused.with.name, undefined);
});

test('build, pack, custody and smoke run only in the isolated pinned tree with a strict drift check', () => {
  const job = workflow().jobs['release-build'];
  const names = job.steps.map(step => step.name);
  const one = name => { const rows = job.steps.filter(step => step.name === name); assert.equal(rows.length, 1); return rows[0]; };
  const tree = one('Create isolated release tree');
  assert.equal(tree.id, 'tree');
  assert.equal(tree.if, "steps.eligible.outputs.ready == 'true'");
  assert.equal(tree.run, 'node scripts/release-isolated-tree.mjs create "$RUNNER_TEMP/phantom-release-tree"');
  for (const later of ['Cache native compiler inputs', 'Build unsigned desktop and original package once',
    'Capture original immutable input custody', 'Smoke desktop release artifact']) {
    assert.ok(names.indexOf('Create isolated release tree') < names.indexOf(later), `${later} must follow tree creation`);
  }
  // Any step that builds, packs, captures or smokes must run in the tree.
  const isolated = job.steps.filter(step => /build:desktop:nightly|release-fast-smoke\.mjs prepare|release-local-input\.mjs|release-smoke-phase\.mjs smoke/.test(step.run ?? ''));
  assert.deepEqual(isolated.map(step => step.name), ['Build unsigned desktop and original package once',
    'Capture original immutable input custody', 'Smoke desktop release artifact']);
  for (const step of isolated) assert.equal(step['working-directory'], '${{ steps.tree.outputs.root }}');
  const build = one('Build unsigned desktop and original package once').run.trim().split('\n');
  assert.deepEqual(build, ['npm run build:desktop:nightly -- --existing-icons', 'node scripts/release-isolated-tree.mjs verify .',
    'node .github/scripts/release-fast-smoke.mjs prepare', 'node scripts/release-isolated-tree.mjs verify .']);
  assert.ok(one('Build unsigned desktop and original package once')['timeout-minutes'] <= 45);
  assert.ok(one('Smoke desktop release artifact')['timeout-minutes'] <= 6);
});

test('native cache is keyed by the lockfile, never the commit, at the stable isolated target path', () => {
  const cache = workflow().jobs['release-build'].steps.find(step => step.name === 'Cache native compiler inputs');
  assert.ok(!/github\.sha/.test(cache.with.key) && !/github\.sha/.test(cache.with['restore-keys']));
  assert.ok(cache.with.key.endsWith("${{ hashFiles('desktop/src-tauri/Cargo.lock') }}"));
  assert.ok(cache.with.key.startsWith(cache.with['restore-keys']));
  assert.deepEqual(cache.with.path.trim().split('\n'), ['~/.cargo/registry/', '~/.cargo/git/db/',
    '${{ steps.tree.outputs.root }}/desktop/src-tauri/target/']);
});

test('pinned tool install overlaps setup and its exit status gates the build', () => {
  const job = workflow().jobs['release-build'];
  const names = job.steps.map(step => step.name);
  const start = job.steps.find(step => step.name === 'Start pinned build tool install');
  const gate = job.steps.find(step => step.name === 'Install pinned build tools');
  assert.match(start.run, /\( set \+e; npm install --global npm@10\.9\.8 @tauri-apps\/cli@2\.11\.4 .*\n\s*echo "\$\?" > "\$RUNNER_TEMP\/build-tools\.status" \) &/);
  assert.match(gate.run, /build-tools\.status/);
  assert.match(gate.run, /exit 1/);
  assert.ok(gate['timeout-minutes'] <= 5);
  assert.ok(names.indexOf('Start pinned build tool install') < names.indexOf('Set up Rust'));
  assert.ok(names.indexOf('Install pinned build tools') < names.indexOf('Build unsigned desktop and original package once'));
});
