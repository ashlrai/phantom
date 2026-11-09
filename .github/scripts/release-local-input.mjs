/* global process, console */
// One input path: the same four files uploaded by the pinned immutable action.
// This witness is not release authority; every use rechecks bytes and the API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectTar, sourceBinding } from '../../scripts/hosted-build-artifact.mjs';
import { requireProducerEnvironment, requireRepositoryReference } from './github-repository-binding.mjs';

const files = ['build-manifest.json', 'desktop-smoke-bin', 'dist.tar', 'package.tgz'];
const caps = { 'build-manifest.json': 32 * 1024 * 1024, 'desktop-smoke-bin': 512 * 1024 * 1024,
  'dist.tar': 640 * 1024 * 1024, 'package.tgz': 128 * 1024 * 1024 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = value => Object.fromEntries(['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(value[key])]));
const owned = st => st.uid === BigInt(process.getuid()) && (st.mode & 0o022n) === 0n;
function readOwned(path, cap) {
  const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && owned(before)
    && before.size > 0n && before.size <= BigInt(cap), 'unsafe local input file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.deepEqual(stamp(fstatSync(fd, { bigint: true })), stamp(before));
    const bytes = readFileSync(fd);
    assert.deepEqual(stamp(fstatSync(fd, { bigint: true })), stamp(before));
    assert.deepEqual(stamp(lstatSync(path, { bigint: true })), stamp(before));
    assert.equal(BigInt(bytes.length), before.size);
    return { bytes, stamp: stamp(before), sha256: sha(bytes) };
  } finally { closeSync(fd); }
}
const positiveText = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
export function producerRef(env) {
  const { repository } = requireProducerEnvironment(env);
  assert.ok(positiveText(env.GITHUB_RUN_ID) && positiveText(env.GITHUB_RUN_ATTEMPT));
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_REF, 'refs/heads/master');
  return { repository, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, revision: env.GITHUB_SHA };
}
const preparedPath = env => join(realpathSync(env.RUNNER_TEMP), 'release-prepared');
const witnessPath = env => join(realpathSync(env.RUNNER_TEMP), 'release-input-witness.json');

export function snapshotInput(prepared) {
  assert.equal(realpathSync(prepared), resolve(prepared));
  const before = lstatSync(prepared, { bigint: true });
  assert.ok(before.isDirectory() && !before.isSymbolicLink() && owned(before));
  assert.deepEqual(readdirSync(prepared).sort(), files);
  const members = Object.fromEntries(files.map(name => {
    const { stamp, sha256 } = readOwned(join(prepared, name), caps[name]); return [name, { stamp, sha256 }];
  }));
  assert.deepEqual(readdirSync(prepared).sort(), files);
  assert.deepEqual(stamp(lstatSync(prepared, { bigint: true })), stamp(before));
  return { directory: stamp(before), members };
}

export function captureInput(env = process.env, root = process.cwd()) {
  const record = { schemaVersion: 1, producer: producerRef(env), sourceSha256: sha(JSON.stringify(sourceBinding(root, env.GITHUB_SHA))),
    snapshot: snapshotInput(preparedPath(env)) };
  writeFileSync(witnessPath(env), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o400 });
  return record;
}

export function validateUploadedInput(record, env, artifact, run) {
  const producer = producerRef(env);
  assert.equal(record.schemaVersion, 1); assert.deepEqual(record.producer, producer);
  assert.ok(positiveText(env.INPUT_ARTIFACT_ID));
  assert.match(env.INPUT_ARTIFACT_DIGEST ?? '', /^[a-f0-9]{64}$/);
  assert.equal(artifact.id, Number(env.INPUT_ARTIFACT_ID));
  assert.equal(artifact.name, `phantom-release-input-${producer.run}-${producer.attempt}`);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, `sha256:${env.INPUT_ARTIFACT_DIGEST}`);
  assert.equal(artifact.workflow_run?.id, Number(producer.run));
  assert.equal(artifact.workflow_run?.head_sha, producer.revision);
  requireRepositoryReference(producer.repository, run.repository);
  assert.equal(run.id, Number(producer.run)); assert.equal(run.run_attempt, Number(producer.attempt));
  assert.equal(run.head_sha, producer.revision); assert.equal(run.head_branch, 'master');
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.ok(['workflow_dispatch', 'schedule'].includes(run.event));
  assert.equal(run.status, 'in_progress');
  return producer;
}

export function verifyLocalInput(env = process.env, root = process.cwd(), read = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint],
  { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }))) {
  const record = JSON.parse(readOwned(witnessPath(env), 16 * 1024).bytes);
  assert.equal(record.sourceSha256, sha(JSON.stringify(sourceBinding(root, env.GITHUB_SHA))));
  assert.deepEqual(record.snapshot, snapshotInput(preparedPath(env)), 'local immutable input changed');
  const producer = producerRef(env);
  const artifact = read(`repos/${producer.repository}/actions/artifacts/${env.INPUT_ARTIFACT_ID}`);
  const run = read(`repos/${producer.repository}/actions/runs/${producer.run}/attempts/${producer.attempt}`);
  validateUploadedInput(record, env, artifact, run);
  assert.deepEqual(record.snapshot, snapshotInput(preparedPath(env)), 'local input changed during API verification');
  return record;
}

// Fresh builds leave dist in the workspace. Verify its complete admitted
// membership/bytes/modes, then retain it under an exclusive backup name. The
// existing smoke still restores dist.tar itself and refuses any overwrite.
export function retainFreshDist({ root, prepared, backup }) {
  const archive = readOwned(join(prepared, 'dist.tar'), caps['dist.tar']);
  const manifest = JSON.parse(readOwned(join(prepared, 'build-manifest.json'), caps['build-manifest.json']).bytes);
  assert.equal(archive.sha256, manifest.archive.sha256); assert.equal(archive.bytes.length, manifest.archive.bytes);
  const entries = inspectTar(archive.bytes, manifest.archive.entries);
  assert.ok(entries[0].path === 'dist' && entries[0].type === 'directory'
    && entries.every(entry => entry.path === 'dist' || entry.path.startsWith('dist/')));
  const observed = [];
  const walk = relative => {
    const path = join(root, relative); const st = lstatSync(path, { bigint: true });
    assert.ok(owned(st) && !st.isSymbolicLink());
    const mode = Number(st.mode & 0o777n);
    if (st.isDirectory()) {
      const before = stamp(st); observed.push({ path: relative, type: 'directory', mode });
      for (const name of readdirSync(path).sort()) walk(`${relative}/${name}`);
      assert.deepEqual(stamp(lstatSync(path, { bigint: true })), before);
    } else {
      const file = readOwned(path, caps['dist.tar']);
      observed.push({ path: relative, type: 'file', mode, bytes: file.bytes.length, sha256: file.sha256 });
    }
    assert.ok(observed.length <= 100_000);
  };
  const before = stamp(lstatSync(join(root, 'dist'), { bigint: true })); walk('dist');
  assert.deepEqual(observed.sort((a, b) => a.path.localeCompare(b.path)), [...entries].sort((a, b) => a.path.localeCompare(b.path)));
  assert.deepEqual(stamp(lstatSync(join(root, 'dist'), { bigint: true })), before);
  // Backup is below an exclusively-created private directory, not a caller's
  // existing destination. No recursive deletion or copy of arbitrary data.
  assert.deepEqual(readdirSync(backup), []);
  renameSync(join(root, 'dist'), join(backup, 'dist'));
  const after = stamp(lstatSync(join(backup, 'dist'), { bigint: true }));
  // The owned rename changes ctime on Darwin. All other captured identity and
  // membership metadata must remain equal; the retained backup is never used
  // as qualification input.
  for (const key of Object.keys(before).filter(key => key !== 'ctimeNs')) assert.equal(after[key], before[key]);
}

async function main() {
  const [verb, ...extra] = process.argv.slice(2); assert.equal(extra.length, 0);
  if (verb === 'capture') return captureInput();
  assert.equal(verb, 'verify'); return verifyLocalInput();
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('same-runner release input refused'); process.exitCode = 1; });
}
