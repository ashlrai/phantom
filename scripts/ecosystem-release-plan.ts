/** Source-only local planner. No scanning, package scripts, network or effect execution. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEcosystemReleasePlan } from '../src/core/ecosystem/release-plan.js';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** Reads at most the observed size plus one byte, even if the held inode grows. */
export function readBoundedSnapshotBytes(fd: number, observedSize: number): Buffer {
  if (!Number.isSafeInteger(observedSize) || observedSize < 2 || observedSize > MAX_SNAPSHOT_BYTES) throw new Error('Unsafe local snapshot');
  const bytes = Buffer.alloc(observedSize + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = readSync(fd, bytes, count, bytes.length - count, count);
    if (read === 0) break;
    count += read;
  }
  if (count !== observedSize) throw new Error('Changed local snapshot');
  return bytes.subarray(0, count);
}
function localJson(path: string): unknown {
  const target = resolve(path); const before = lstatSync(target);
  if (realpathSync(target) !== target || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_SNAPSHOT_BYTES) throw new Error('Unsafe local snapshot');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = fstatSync(fd);
    if (!held.isFile()) throw new Error('Changed local snapshot');
    const bytes = readBoundedSnapshotBytes(fd, before.size); const after = fstatSync(fd); const name = lstatSync(target);
    if ([held, after, name].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs || s.mode !== before.mode || s.nlink !== 1)
      || bytes.length !== before.size) throw new Error('Changed local snapshot');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally { closeSync(fd); }
}
export function runEcosystemReleasePlan(args: string[], nowMs: number): ReturnType<typeof buildEcosystemReleasePlan> {
  if (args.length !== 2 || args[0] !== '--input' || !args[1] || args[1].startsWith('--')) throw new Error('Usage: source planner --input local-snapshot.json');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return buildEcosystemReleasePlan(localJson(args[1]), nowMs, localJson(join(root, 'docs/ecosystem-index.json')));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(runEcosystemReleasePlan(process.argv.slice(2), Date.now()), null, 2) + '\n'); }
  catch { process.stderr.write('ecosystem-release-plan: invalid local input or source registry\n'); process.exitCode = 1; }
}
