/** Shared private-file custody, lock, config, and bounded-response helpers for remote web modules. */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, rmSync, writeSync, type Stats,
} from 'node:fs';
import { parseRemoteAccessConfig, type RemoteAccessConfig } from './remote-access.js';

export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_REMOTE_CONFIG_BYTES = 8_192;

export function isBase64UrlBytes(value: unknown, expectedBytes: number): value is string {
  return typeof value === 'string' && BASE64URL_RE.test(value)
    && Buffer.from(value, 'base64url').length === expectedBytes;
}

export function lstatOrNull(target: string): Stats | null {
  try { return lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function assertPrivatePath(
  target: string,
  kind: 'directory' | 'file' | 'socket',
  message: string,
): Stats {
  const stat = lstatSync(target);
  const rightKind = kind === 'directory' ? stat.isDirectory()
    : kind === 'file' ? stat.isFile()
      : stat.isSocket();
  if (stat.isSymbolicLink() || !rightKind || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(message);
  }
  return stat;
}

export function ensurePrivateDirectory(root: string, message: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, 'directory', message);
}

/** Acquire a non-stolen create-exclusive 0600 PID lock inside a private root directory. */
export function withPrivateFileLock<T>(
  root: string,
  lockPath: string,
  dirMessage: string,
  lockMessage: string,
  fn: () => T,
): T {
  ensurePrivateDirectory(root, dirMessage);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error(lockMessage);
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

export function readPrivateJsonRecord(
  target: string,
  maxBytes: number,
  labels: { notPrivate: string; tooLarge: string; unreadable: string; invalid: string },
): Record<string, unknown> {
  const stat = assertPrivatePath(target, 'file', labels.notPrivate);
  if (stat.size > maxBytes) throw new Error(labels.tooLarge);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown; }
  catch { throw new Error(labels.unreadable); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(labels.invalid);
  return parsed as Record<string, unknown>;
}

/** TOCTOU-hardened reader for the private 0600 remote phone gateway config JSON. */
export function readRemoteGatewayConfig(path: string): { access: RemoteAccessConfig; gatewayPort: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Remote gateway config must be a private 0600 file owned by this user');
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev
      || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || stat.size > MAX_REMOTE_CONFIG_BYTES) {
      throw new Error('Remote gateway config must be a private 0600 file owned by this user');
    }
    const buffer = Buffer.alloc(MAX_REMOTE_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_REMOTE_CONFIG_BYTES) {
      throw new Error('Remote gateway config must be a private 0600 file owned by this user');
    }
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote gateway config');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'access' && key !== 'gatewayPort')) {
      throw new Error('Invalid remote gateway config');
    }
    const access = parseRemoteAccessConfig(record.access);
    const gatewayPort = record.gatewayPort;
    if (!access || !Number.isInteger(gatewayPort) || (gatewayPort as number) < 1 || (gatewayPort as number) > 65535) {
      throw new Error('Remote gateway Access config or port is invalid');
    }
    return { access, gatewayPort: gatewayPort as number };
  } finally {
    closeSync(fd);
  }
}

/** Read a Fetch Response body up to `maxBytes`, cancelling and returning null if exceeded. */
export async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Buffer | null> {
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
  } finally {
    reader.releaseLock();
  }
}
