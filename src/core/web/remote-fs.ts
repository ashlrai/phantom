/** Shared private-filesystem, lockfile and config-reading helpers for the opt-in phone gateway. */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeSync,
  type Stats,
} from 'node:fs';
import { parseRemoteAccessConfig, type RemoteAccessConfig } from './remote-access.js';

export type PrivatePathKind = 'directory' | 'file' | 'socket';

const REMOTE_CONFIG_MAX_BYTES = 8_192;

/** Return lstat metadata or null on ENOENT; rethrow all other errors. */
export function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** True when `stat` is a non-symlink of `kind`, mode 0600/0700 (no group/other bits), owned by this user. */
export function isPrivateStat(stat: Stats, kind: PrivatePathKind): boolean {
  if (stat.isSymbolicLink()) return false;
  const kindMatches = kind === 'directory' ? stat.isDirectory() : kind === 'file' ? stat.isFile() : stat.isSocket();
  return kindMatches && (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

/** Verify `path` is a private, user-owned non-symlink of `kind` and return its lstat. */
export function assertPrivatePath(path: string, kind: PrivatePathKind, message: string): Stats {
  const stat = lstatSync(path);
  if (!isPrivateStat(stat, kind)) throw new Error(message);
  return stat;
}

/** Read and JSON-parse a bounded private 0600 file with caller-specified error labels. */
export function readPrivateJsonFile(path: string, maxBytes: number, label: string, notPrivateMessage = `${label} is not private`): unknown {
  const stat = assertPrivatePath(path, 'file', notPrivateMessage);
  if (stat.size > maxBytes) throw new Error(`${label} is too large`);
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new Error(`${label} is unreadable`); }
}

/** Create a private root dir and hold a create-exclusive O_NOFOLLOW lockfile for `fn`. Never steals an existing lock. */
export function withPrivateFileLock<T>(
  root: string, lockPath: string, rootNotPrivate: string, lockNotPrivate: string, fn: () => T,
): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, 'directory', rootNotPrivate);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error(lockNotPrivate);
    return fn();
  } finally { closeSync(fd); rmSync(lockPath, { force: true }); }
}

/** Read and validate the private remote-gateway JSON config using O_NOFOLLOW + fstat identity verification. */
export function readRemoteGatewayConfig(path: string): { access: RemoteAccessConfig; gatewayPort: number } {
  const notPrivateMessage = 'Remote gateway config must be a private 0600 file owned by this user';
  const before = assertPrivatePath(path, 'file', notPrivateMessage);
  if (before.size > REMOTE_CONFIG_MAX_BYTES) throw new Error(notPrivateMessage);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!isPrivateStat(stat, 'file') || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > REMOTE_CONFIG_MAX_BYTES) {
      throw new Error(notPrivateMessage);
    }
    const buffer = Buffer.alloc(REMOTE_CONFIG_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > REMOTE_CONFIG_MAX_BYTES) throw new Error(notPrivateMessage);
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote gateway config');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'access' && key !== 'gatewayPort')) throw new Error('Invalid remote gateway config');
    const access = parseRemoteAccessConfig(record.access);
    const gatewayPort = record.gatewayPort;
    if (!access || !Number.isInteger(gatewayPort) || (gatewayPort as number) < 1 || (gatewayPort as number) > 65535) {
      throw new Error('Remote gateway Access config or port is invalid');
    }
    return { access, gatewayPort: gatewayPort as number };
  } finally { closeSync(fd); }
}
