import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureInput, retainFreshDist, snapshotInput, validateUploadedInput, verifyLocalInput } from '../scripts/release-local-input.mjs';
import { restorePreparedDist } from '../scripts/release-fast-smoke.mjs';
import { preparedArchiveFixture } from './fixtures/release-prepared.mjs';

const repository = { full_name: 'ashlrai/phantom', id: 1263526319, node_id: 'R_kgDOS0_hrw', owner: { id: 258113726, login: 'ashlrai' } };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'local-release-')); const root = join(dir, 'source'); const prepared = join(dir, 'release-prepared');
  mkdirSync(root); mkdirSync(prepared, { mode: 0o700 }); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"name":"private-test","version":"1.0.0"}\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', 'package.json']);
  execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const env = { RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'ashlrai/phantom', GITHUB_REPOSITORY_ID: '1263526319',
    GITHUB_REPOSITORY_OWNER_ID: '258113726', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), GITHUB_REF: 'refs/heads/master',
    INPUT_ARTIFACT_ID: '123', INPUT_ARTIFACT_DIGEST: 'b'.repeat(64) };
  for (const name of ['build-manifest.json', 'dist.tar', 'package.tgz', 'desktop-smoke-bin']) writeFileSync(join(prepared, name), name, { mode: 0o600 });
  const artifact = { id: 123, name: 'phantom-release-input-100-1', digest: `sha256:${env.INPUT_ARTIFACT_DIGEST}`, expired: false, workflow_run: { id: 100, head_sha: env.GITHUB_SHA } };
  const run = { id: 100, run_attempt: 1, repository, head_sha: env.GITHUB_SHA, head_branch: 'master', path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'in_progress' };
  const read = path => path.includes('/artifacts/') ? artifact : run;
  return { dir, root, prepared, env, artifact, run, read };
}
test('same-runner original uploaded input is rebound to exact source, run, attempt and digest', t => {
  const f = fixture(t); const record = captureInput(f.env, f.root);
  assert.deepEqual(verifyLocalInput(f.env, f.root, f.read), record);
  assert.throws(() => captureInput(f.env, f.root), { custodyCode: 'witness_unavailable' });
});
for (const mutation of ['bytes', 'same-size bytes', 'extra', 'missing', 'symlink', 'hardlink', 'mode', 'artifact digest', 'artifact id', 'artifact name', 'artifact source', 'artifact run', 'expired', 'attempt', 'dirty source']) {
  test(`same-runner input refuses ${mutation} before executing original bytes`, t => {
    const f = fixture(t); captureInput(f.env, f.root); const file = join(f.prepared, 'desktop-smoke-bin');
    if (mutation === 'bytes') writeFileSync(file, 'changed');
    if (mutation === 'same-size bytes') writeFileSync(file, 'X'.repeat(readFileSync(file).length));
    if (mutation === 'extra') writeFileSync(join(f.prepared, 'extra'), 'x');
    if (mutation === 'missing') unlinkSync(file);
    if (mutation === 'symlink') { unlinkSync(file); symlinkSync(join(f.prepared, 'package.tgz'), file); }
    if (mutation === 'hardlink') linkSync(file, join(f.dir, 'alias'));
    if (mutation === 'mode') chmodSync(file, 0o666);
    if (mutation === 'artifact digest') f.artifact.digest = `sha256:${'c'.repeat(64)}`;
    if (mutation === 'artifact id') f.artifact.id++;
    if (mutation === 'artifact name') f.artifact.name = 'phantom-release-input-100-2';
    if (mutation === 'artifact source') f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    if (mutation === 'artifact run') f.artifact.workflow_run.id++;
    if (mutation === 'expired') f.artifact.expired = true;
    if (mutation === 'attempt') f.run.run_attempt++;
    if (mutation === 'dirty source') writeFileSync(join(f.root, 'package.json'), '{}');
    assert.throws(() => verifyLocalInput(f.env, f.root, f.read));
  });
}
test('consumer attempt two cannot reconstruct or substitute producer attempt-one input', t => {
  const f = fixture(t); const record = captureInput(f.env, f.root);
  // Reuse keeps the producer tuple explicit; a consumer must not replace it.
  assert.doesNotThrow(() => validateUploadedInput(record, f.env, f.artifact, f.run));
  assert.throws(() => validateUploadedInput(record, { ...f.env, GITHUB_RUN_ATTEMPT: '2' }, f.artifact, { ...f.run, run_attempt: 2 }));
  assert.equal(f.artifact.name, 'phantom-release-input-100-1');
});
for (const mutation of ['unchanged', 'bytes', 'mode', 'extra', 'backup occupied']) test(`fresh dist ${mutation}: no blind overwrite or unqualified local shortcut`, t => {
  const f = preparedArchiveFixture(t); writeFileSync(join(f.prepared, 'build-manifest.json'), JSON.stringify(f.manifest));
  restorePreparedDist(f); const backup = mkdtempSync(join(tmpdir(), 'dist-backup-')); t.after(() => rmSync(backup, { recursive: true, force: true }));
  if (mutation === 'bytes') writeFileSync(join(f.root, 'dist/worker.js'), 'different');
  if (mutation === 'mode') chmodSync(join(f.root, 'dist/worker.js'), 0o600);
  if (mutation === 'extra') writeFileSync(join(f.root, 'dist/extra'), 'unadmitted');
  if (mutation === 'backup occupied') writeFileSync(join(backup, 'sentinel'), 'preserve');
  const action = () => retainFreshDist({ ...f, backup });
  if (mutation !== 'unchanged') { assert.throws(action); assert.ok(existsSync(join(f.root, 'dist'))); return; }
  action(); assert.equal(existsSync(join(f.root, 'dist')), false); assert.ok(existsSync(join(backup, 'dist/worker.js')));
  restorePreparedDist(f); assert.deepEqual(readFileSync(join(f.root, 'dist/worker.js')), f.content);
});
test('complete input inventory is required even without a witness', t => {
  const f = fixture(t); writeFileSync(join(f.prepared, 'other'), 'x'); assert.throws(() => snapshotInput(f.prepared));
});

test('capture reports fixed reason codes without exposing underlying paths or values', t => {
  const f = fixture(t);
  assert.throws(() => captureInput({ ...f.env, GITHUB_REF: 'refs/tags/v1.0.0' }, f.root), { custodyCode: 'wrong_runner' });
  writeFileSync(join(f.root, 'package.json'), '{}');
  assert.throws(() => captureInput(f.env, f.root), { custodyCode: 'stale_checkout' });
  execFileSync('git', ['-C', f.root, 'checkout', '--', 'package.json']);
  unlinkSync(join(f.prepared, 'dist.tar'));
  assert.throws(() => captureInput(f.env, f.root), { custodyCode: 'invalid_input' });
});
