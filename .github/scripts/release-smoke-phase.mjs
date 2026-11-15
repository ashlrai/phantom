/* global process, console */
// Timing metadata only: final qualification still reads actual successful API steps.
import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { runBoundedCommand } from '../../scripts/run-bounded-command.mjs';
import { producerRef } from './release-local-input.mjs';

export const SMOKE_PHASE_MS = 300_000;
function identity(env) {
  return producerRef(env);
}
const location = env => join(realpathSync(env.RUNNER_TEMP), 'release-smoke-phase.json');
const same = (a, b) => ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

export function startPhase(env = process.env, now = Date.now()) {
  assert.ok(Number.isSafeInteger(now) && now > 0);
  const record = { schemaVersion: 1, ...identity(env), startedAt: now, deadline: now + SMOKE_PHASE_MS };
  writeFileSync(location(env), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o400 });
  return record;
}

export function readPhase(env = process.env, now = Date.now()) {
  const path = location(env); const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o400n && before.size <= 2048n);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.ok(same(before, fstatSync(fd, { bigint: true })));
    const raw = readFileSync(fd); const record = JSON.parse(raw);
    assert.ok(same(before, fstatSync(fd, { bigint: true })) && same(before, lstatSync(path, { bigint: true })));
    assert.deepEqual(Object.keys(record).sort(), ['schemaVersion', 'repository', 'run', 'attempt', 'revision', 'startedAt', 'deadline'].sort());
    assert.equal(record.schemaVersion, 1);
    for (const [key, value] of Object.entries(identity(env))) assert.equal(record[key], value);
    assert.ok(Number.isSafeInteger(now) && Number.isSafeInteger(record.startedAt) && record.startedAt > 0
      && Number.isSafeInteger(record.deadline) && record.deadline === record.startedAt + SMOKE_PHASE_MS
      && record.startedAt <= now && now < record.deadline, 'smoke phase expired or has invalid timing');
    return record;
  } finally { closeSync(fd); }
}

async function main() {
  const [verb, ...extra] = process.argv.slice(2); assert.equal(extra.length, 0);
  if (verb === 'start') return startPhase();
  if (verb === 'finish') return readPhase();
  assert.ok(['push', 'smoke'].includes(verb), 'unknown fixed smoke command');
  const phase = readPhase();
  // Parent remains responsive while the existing helper does synchronous work.
  // Deadline initiates TERM; the existing bounded runner retains its 5s KILL grace.
  process.exitCode = await runBoundedCommand({ command: process.execPath,
    args: [fileURLToPath(new URL('./release-fast-smoke.mjs', import.meta.url)), verb],
    timeoutMs: phase.deadline - Date.now(), killAfterMs: 5000 });
  if (!process.exitCode) readPhase();
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('release smoke phase refused'); process.exitCode = 1; });
}
