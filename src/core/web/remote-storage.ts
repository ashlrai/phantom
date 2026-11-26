/**
 * Shared private-storage, exclusive-lock, bounded-read, and gateway-config
 * helpers for the opt-in remote phone gateway and its local custody stores.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, rmSync, type Stats, writeSync } from 'node:fs';
import { parseRemoteAccessConfig, type RemoteAccessConfig } from './remote-access.js';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const REMOTE_GATEWAY_CONFIG_MAX_BYTES = 8_192;
const BOUNDED_READ_CHUNK_BYTES = 16_384;

export type PrivatePathKind = 'directory' | 'file' | 'socket';
export interface PrivateJsonReadErrors { notPrivate: string; tooLarge: string; unreadable: string }
export interface RemoteGatewayConfig { access: RemoteAccessConfig; gatewayPort: number }

/** Return `lstatSync(path)` or `null` when missing; rethrow all other errors. */
export function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** True when `stat` is a non-symlink of `kind`, mode 0700/0600 (no group/other bits), owned by this user. */
export function isPrivateStat(stat: Stats, kind: PrivatePathKind): boolean {
  if (stat.isSymbolicLink()) return false;
  const ok = kind === 'directory' ? stat.isDirectory() : kind === 'file' ? stat.isFile() : stat.isSocket();
  return ok && (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

/** Verify `path` is a private non-symlink of `kind`, returning its `Stats`. */
export function assertPrivatePath(path: string, kind: PrivatePathKind, errorMessage: string): Stats {
  const stat = lstatSync(path);
  if (!isPrivateStat(stat, kind)) throw new Error(errorMessage);
  return stat;
}

/** Create `root` with mode 0700 if absent and verify it is a private owned directory. */
export function ensurePrivateDirectory(root: string, errorMessage: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, 'directory', errorMessage);
}

/** Run `fn` under a create-exclusive private lockfile in `root` (never steals an existing lock). */
export function withPrivateExclusiveLock<T>(
  root: string, lockPath: string, errors: { dirNotPrivate: string; lockNotPrivate: string }, fn: () => T,
): T {
  ensurePrivateDirectory(root, errors.dirNotPrivate);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error(errors.lockNotPrivate);
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

function readPrivateBoundedText(path: string, maxBytes: number, errors: { notPrivate: string; tooLarge: string }): string {
  const before = assertPrivatePath(path, 'file', errors.notPrivate);
  if (before.size > maxBytes) throw new Error(errors.tooLarge);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(errors.notPrivate);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!isPrivateStat(stat, 'file') || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error(errors.notPrivate);
    if (stat.size > maxBytes) throw new Error(errors.tooLarge);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const buf = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, maxBytes + 1 - size));
      const count = readSync(fd, buf, 0, buf.length, null);
      if (!count) break;
      size += count;
      if (size > maxBytes) throw new Error(errors.tooLarge);
      chunks.push(buf.subarray(0, count));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { closeSync(fd); }
}

/** Read and JSON-parse a bounded private file via `O_NOFOLLOW` descriptor custody. */
export function readPrivateJsonFile(path: string, maxBytes: number, errors: PrivateJsonReadErrors): unknown {
  const text = readPrivateBoundedText(path, maxBytes, errors);
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error(errors.unreadable); }
}

/** Read and validate the private remote phone gateway JSON config (`{ access, gatewayPort }`). */
export function readRemoteGatewayConfig(path: string): RemoteGatewayConfig {
  const value = readPrivateJsonFile(path, REMOTE_GATEWAY_CONFIG_MAX_BYTES, {
    notPrivate: 'Remote gateway config must be a private 0600 file owned by this user',
    tooLarge: 'Remote gateway config must be a private 0600 file owned by this user',
    unreadable: 'Invalid remote gateway config',
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote gateway config');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'access' && key !== 'gatewayPort')) throw new Error('Invalid remote gateway config');
  const access = parseRemoteAccessConfig(record.access);
  const gatewayPort = record.gatewayPort;
  if (!access || !Number.isInteger(gatewayPort) || (gatewayPort as number) < 1 || (gatewayPort as number) > 65535) {
    throw new Error('Remote gateway Access config or port is invalid');
  }
  return { access, gatewayPort: gatewayPort as number };
}

/** Read a Fetch `Response` stream into a Buffer capped at `maxBytes`; returns `null` when missing or oversized. */
export async function readBoundedResponseBuffer(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}

/** True when `value` is a base64url string whose decoded byte length equals `byteLength`. */
export function isValidBase64UrlBytes(value: unknown, byteLength: number): value is string {
  return typeof value === 'string' && BASE64URL_RE.test(value) && Buffer.from(value, 'base64url').length === byteLength;
}
