/**
 * Durable delivery state for needs-you replies relayed to the planner inbox.
 * One tiny JSON file per item under `<runsDir>/needs-mason-delivery/`, holding
 * the already-validated inbox message (never the raw reply) until an append is
 * confirmed. Not a general outbox: one item, one message, one receipt.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 4 * 1024;
const DIR = 'needs-mason-delivery';

export interface DeliveryState {
  status: 'pending' | 'delivered';
  /** Inbox text accepted on the first resolve; replaced by '' once delivered. */
  message: string; source: string; cursor: number; duplicate: boolean;
}
/** `unsafe` covers malformed, oversized, symlinked or unreadable state: never overwritten. */
export type DeliveryRead = { kind: 'none' } | { kind: 'state'; state: DeliveryState } | { kind: 'unsafe' };

const pathOf = (runsDir: string, itemId: string): string => join(runsDir, DIR, `${itemId}.json`);

export function readDelivery(runsDir: string, itemId: string): DeliveryRead {
  const path = pathOf(runsDir, itemId);
  try { lstatSync(path); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unsafe' };
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return { kind: 'unsafe' }; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES) return { kind: 'unsafe' };
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const parsed = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as Record<string, unknown>;
    if ((parsed.status !== 'pending' && parsed.status !== 'delivered') || typeof parsed.message !== 'string'
      || typeof parsed.source !== 'string' || typeof parsed.cursor !== 'number' || typeof parsed.duplicate !== 'boolean'
      || (parsed.status === 'pending' && !parsed.message)) return { kind: 'unsafe' };
    return { kind: 'state', state: parsed as unknown as DeliveryState };
  } catch { return { kind: 'unsafe' }; } finally { closeSync(fd); }
}

/** Create the state directory (0700) and refuse a symlinked or non-directory path. */
export function ensureDeliveryDir(runsDir: string): boolean {
  const dir = join(runsDir, DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch { return false; }
}

/** Atomic replace via an exclusive temp file; false when storage is unavailable. */
export function writeDelivery(runsDir: string, itemId: string, state: DeliveryState): boolean {
  if (!ensureDeliveryDir(runsDir)) return false;
  const path = pathOf(runsDir, itemId), tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(state)); } finally { closeSync(fd); }
    renameSync(tmp, path);
    return true;
  } catch { rmSync(tmp, { force: true }); return false; }
}

const queues = new Map<string, Promise<unknown>>();
/** Serialize work per key within this process; a failed predecessor never blocks the next caller. */
export function serializeDelivery<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}
