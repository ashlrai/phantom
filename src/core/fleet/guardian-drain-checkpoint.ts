import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

const NAME = 'guardian-drain-latest.json';
const MAX_BYTES = 16 * 1024;
export interface GuardianDrainCheckpoint {
  version: 1; latestOutput: string; repo: string; sha: string; completedAt: string;
}

function validate(directory: string, value: unknown): GuardianDrainCheckpoint {
  if (!isAbsolute(directory) || directory.length > 4096 || directory.includes('\0') || resolve(directory) !== directory ||
      !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid guardian drain checkpoint');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'completedAt,latestOutput,repo,sha,version' || v.version !== 1 ||
      typeof v.latestOutput !== 'string' || v.latestOutput.length > 4096 || dirname(v.latestOutput) !== directory ||
      !/^guardian-drain-attempt-([1-9]|1[0-9]|20)\.json$/.test(basename(v.latestOutput)) ||
      typeof v.repo !== 'string' || !isAbsolute(v.repo) || resolve(v.repo) !== v.repo || v.repo.length > 4096 || [...v.repo].some(c => { const n = c.codePointAt(0)!; return n <= 31 || n === 127; }) ||
      typeof v.sha !== 'string' || !/^[a-f0-9]{40}$/.test(v.sha) ||
      typeof v.completedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.completedAt) ||
      !Number.isFinite(Date.parse(v.completedAt)) || new Date(v.completedAt).toISOString() !== v.completedAt) {
    throw new Error('Invalid guardian drain checkpoint');
  }
  return v as unknown as GuardianDrainCheckpoint;
}

/** Read only the fixed, private checkpoint in the explicitly supplied directory. */
export function readGuardianDrainCheckpoint(directory: string): GuardianDrainCheckpoint | null {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory.length > 4096 || directory.includes('\0')) throw new Error('Invalid checkpoint directory');
  if (!assurePrivateStoragePath(directory, 'directory', 'inspect-existing', { anchorPath: directory }).ok) throw new Error('Unsafe checkpoint directory');
  const path = join(directory, NAME);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid()) || (before.mode & 0o077) !== 0 ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: directory }).ok) throw new Error('Unsafe checkpoint');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    const after = fstatSync(fd);
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Checkpoint changed during read');
    return validate(directory, JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown);
  } finally { closeSync(fd); }
}

export function writeGuardianDrainCheckpoint(directory: string, checkpoint: GuardianDrainCheckpoint): void {
  const data = JSON.stringify(validate(directory, checkpoint)) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Checkpoint too large');
  if (!assurePrivateStoragePath(directory, 'directory', 'inspect-existing', { anchorPath: directory }).ok) throw new Error('Unsafe checkpoint directory');
  // Refuse unsafe existing input before replacement; absence is permitted.
  readGuardianDrainCheckpoint(directory);
  writePrivateFileAtomically(join(directory, `.${NAME}.${randomUUID()}.tmp`), join(directory, NAME), data,
    { anchorPath: directory, label: 'guardian drain checkpoint' });
}
