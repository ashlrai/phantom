/* global process */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { readPhase, SMOKE_PHASE_MS, startPhase } from '../scripts/release-smoke-phase.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-phase-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'ashlrai/phantom',
    GITHUB_REPOSITORY_ID: '1263526319', GITHUB_REPOSITORY_OWNER_ID: '258113726',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/master' };
  delete env.NODE_OPTIONS;
  return { dir, env, path: join(dir, 'release-smoke-phase.json') };
}
test('one fixed five-minute phase spans sequential real steps, without a budget override', t => {
  const f = fixture(t); const record = startPhase(f.env);
  assert.equal(record.deadline - record.startedAt, 300_000);
  assert.equal(SMOKE_PHASE_MS, 300_000);
  assert.deepEqual(readPhase(f.env), record);
  assert.throws(() => startPhase(f.env), /EEXIST/);
});
for (const mutation of ['attempt', 'revision', 'expired', 'future', 'extended', 'array', 'extra', 'mode', 'symlink', 'hardlink']) {
  test(`phase refuses ${mutation} rather than granting a fresh budget`, t => {
    const f = fixture(t); const record = startPhase(f.env); chmodSync(f.path, 0o600);
    if (mutation === 'attempt') record.attempt = '1';
    if (mutation === 'revision') record.revision = 'b'.repeat(40);
    if (mutation === 'expired') { record.startedAt -= SMOKE_PHASE_MS; record.deadline -= SMOKE_PHASE_MS; }
    if (mutation === 'future') { record.startedAt += 10_000; record.deadline += 10_000; }
    if (mutation === 'extended') record.deadline++;
    if (mutation === 'array') record.attempt = ['2'];
    if (mutation === 'extra') record.approved = true;
    writeFileSync(f.path, JSON.stringify(record)); chmodSync(f.path, mutation === 'mode' ? 0o600 : 0o400);
    if (mutation === 'hardlink') linkSync(f.path, join(f.dir, 'other'));
    if (mutation === 'symlink') { const bytes = readFileSync(f.path); unlinkSync(f.path); writeFileSync(join(f.dir, 'other'), bytes); symlinkSync(join(f.dir, 'other'), f.path); }
    assert.throws(() => readPhase(f.env));
  });
}
for (const form of ['argv', 'NODE_OPTIONS']) test(`upload watchdog terminates a CPU-blocked owned action via ${form} while its parent remains alive`, t => {
  const f = fixture(t); startPhase(f.env, Date.now() - SMOKE_PHASE_MS + 1200);
  const preload = fileURLToPath(new URL('../scripts/release-smoke-upload-deadline.mjs', import.meta.url));
  const env = form === 'NODE_OPTIONS' ? { ...f.env, NODE_OPTIONS: `--import=${preload}` } : f.env;
  const result = spawnSync(process.execPath, [...(form === 'argv' ? ['--import', preload] : []), '-e', 'while (true) {}'],
    { env, timeout: 6000, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.signal, 'SIGKILL');
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
test('qualified upload cannot leave an executable child behind', t => {
  const f = fixture(t); startPhase(f.env);
  const preload = fileURLToPath(new URL('../scripts/release-smoke-upload-deadline.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', preload, '-e', "require('node:child_process').spawn(process.execPath,['-e','while(true){}'])"],
    { env: f.env, timeout: 6000, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /cannot launch executable children/);
});
