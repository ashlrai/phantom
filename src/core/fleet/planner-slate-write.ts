import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { privateDirectory, inspectPrivateDirectory } from '../universe/artifacts.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { PLANNER_CANDIDATES_FILE } from './planner-candidates.js';

export const MAX_SLATE_BYTES = 64 * 1024;
export type Candidate = { provider: string; argv: string[] };
export type Slate = { v: 1; candidates: Candidate[]; lastProvider?: string; promptPath?: string };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]): boolean => Object.keys(x).every(k => allowed.includes(k));
const bounded = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max && !x.includes('\0');

/** Strict validation happens before the storage path is created or changed. */
export function parsePlannerSlate(bytes: Buffer): Slate | null {
  if (bytes.length > MAX_SLATE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(value) || !keys(value, ['v', 'candidates', 'lastProvider', 'promptPath']) || value['v'] !== 1 ||
        !Array.isArray(value['candidates']) || value['candidates'].length < 1 || value['candidates'].length > 64) return null;
    const candidates: Candidate[] = [], seen = new Set<string>();
    for (const row of value['candidates']) {
      if (!record(row) || !keys(row, ['provider', 'argv']) || !bounded(row['provider'], 128) ||
          !row['provider'].trim() || seen.has(row['provider']) || !Array.isArray(row['argv']) ||
          row['argv'].length < 1 || row['argv'].length > 64 ||
          !row['argv'].every((arg: unknown) => bounded(arg, 1024)) || !row['argv'][0].trim()) return null;
      seen.add(row['provider']);
      candidates.push({ provider: row['provider'], argv: row['argv'] as string[] });
    }
    const slate: Slate = { v: 1, candidates };
    if (Object.hasOwn(value, 'lastProvider')) {
      if (!bounded(value['lastProvider'], 128) || !seen.has(value['lastProvider'])) return null;
      slate.lastProvider = value['lastProvider'];
    }
    if (Object.hasOwn(value, 'promptPath')) {
      if (!bounded(value['promptPath'], 1024) || !isAbsolute(value['promptPath'])) return null;
      slate.promptPath = value['promptPath'];
    }
    return Buffer.byteLength(JSON.stringify(slate) + '\n') <= MAX_SLATE_BYTES ? slate : null;
  } catch { return null; }
}

/** Read at most the bound plus one byte, without following links or opening pipes. */
export function readSlateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_SLATE_BYTES) throw new Error('unavailable');
    const bytes = Buffer.alloc(MAX_SLATE_BYTES + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
    const after = fstatSync(fd);
    if (length > MAX_SLATE_BYTES || length !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('unavailable');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

function existing(path: string): { slate: Slate; dev: number; ino: number } | null {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) throw new Error('unavailable');
  const slate = parsePlannerSlate(readSlateFile(path));
  const after = lstatSync(path);
  if (!slate || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs) throw new Error('unavailable');
  return { slate, dev: stat.dev, ino: stat.ino };
}

/** Exclusive lock never reclaims an ambiguous or abandoned lock. */
export function writePlannerSlate(root: string, slate: Slate): 'written' | 'unchanged' | 'refused' {
  try {
    privateDirectory(root);
    const queue = privateDirectory(join(root, 'queue'));
    const lockPath = join(queue, '.planner-candidates.lock');
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const lock = fstatSync(fd);
    try {
      const target = join(root, PLANNER_CANDIDATES_FILE);
      const previous = existing(target);
      const json = JSON.stringify(slate);
      if (previous && JSON.stringify(previous.slate) === json) return 'unchanged';
      inspectPrivateDirectory(root); inspectPrivateDirectory(queue);
      const current = existing(target);
      if ((previous === null) !== (current === null) || (previous && current &&
          (previous.dev !== current.dev || previous.ino !== current.ino || JSON.stringify(previous.slate) !== JSON.stringify(current.slate)))) return 'refused';
      writePrivateFileAtomic(target, `${json}\n`);
      return 'written';
    } finally {
      closeSync(fd);
      try {
        const named = lstatSync(lockPath);
        if (named.isFile() && named.dev === lock.dev && named.ino === lock.ino) unlinkSync(lockPath);
      } catch { /* do not remove a replacement */ }
    }
  } catch { return 'refused'; }
}
