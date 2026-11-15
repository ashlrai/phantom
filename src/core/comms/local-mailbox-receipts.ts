/**
 * Durable, local-only acceptance receipts for the leader mailbox (RQ-PHX-IMSGMAILBOXDEDUPE138).
 *
 * Identity is sha256 over [channel, senderId, idempotencyKey]. Only that opaque
 * hash and the original request id are stored: no message text, no raw handle.
 * Each store is serialised across processes with the shared local-store lock and
 * across instances in this process with a promise queue (the file lock waits
 * synchronously, so an in-process holder must never be awaited by a sibling).
 *
 * Limits, stated plainly: this is NOT transactional exactly-once. The inbox
 * append and the receipt write are two steps. A crash between them leaves an
 * appended entry with no receipt, so a later replay appends once more
 * (at-least-once across that boundary). A receipt write that fails after a
 * successful append is swallowed: the message is accepted, and a replay may
 * duplicate it. Refused, failed or unavailable appends write no receipt, so
 * they stay retryable.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../fleet/local-store-lock.js';

export interface LocalMailboxIdentity {
  channel: string;
  senderId: string;
  idempotencyKey: string;
}

export type LocalMailboxOnceResult =
  | { state: 'accepted' | 'duplicate'; requestId: string }
  | { state: 'declined' | 'unavailable' };

const LOCK_WAIT_MS = 2_000;
const queues = new Map<string, Promise<unknown>>();

export function localMailboxReceiptId(identity: LocalMailboxIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([identity.channel, identity.senderId, identity.idempotencyKey]))
    .digest('hex');
}

function readReceipt(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { requestId?: unknown };
    return typeof parsed.requestId === 'string' && parsed.requestId ? parsed.requestId : null;
  } catch {
    return null; // Missing or unreadable: treated as no prior acceptance.
  }
}

function writeReceipt(dir: string, file: string, requestId: string, at: number): void {
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, requestId, acceptedAt: at }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true }); // Best effort; see the crash-boundary note above.
  }
}

/**
 * Run `append` at most once per identity. `append` returns the new request id
 * on success or null when the inbox refused/failed (no receipt is written).
 */
export async function acceptLocalMailboxOnce(
  options: { runsDir: string; identity: LocalMailboxIdentity; now?: () => number },
  append: () => Promise<string | null>,
): Promise<LocalMailboxOnceResult> {
  const dir = join(options.runsDir, 'leader', '.mailbox-receipts');
  const previous = queues.get(dir) ?? Promise.resolve();
  const run = previous.then(() => attempt(dir, options, append), () => attempt(dir, options, append));
  const settled = run.catch(() => undefined);
  queues.set(dir, settled);
  void settled.then(() => { if (queues.get(dir) === settled) queues.delete(dir); });
  return run;
}

async function attempt(
  dir: string,
  options: { runsDir: string; identity: LocalMailboxIdentity; now?: () => number },
  append: () => Promise<string | null>,
): Promise<LocalMailboxOnceResult> {
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireLocalStoreLock(join(dir, 'writer.lock'), LOCK_WAIT_MS, { anchorPath: options.runsDir });
  } catch {
    return { state: 'unavailable' };
  }
  if (!lock) return { state: 'unavailable' };
  try {
    const file = join(dir, `${localMailboxReceiptId(options.identity)}.json`);
    const prior = readReceipt(file);
    if (prior) return { state: 'duplicate', requestId: prior };
    const requestId = await append();
    if (!requestId) return { state: 'declined' };
    writeReceipt(dir, file, requestId, (options.now ?? Date.now)());
    return { state: 'accepted', requestId };
  } finally {
    releaseLocalStoreLock(lock);
  }
}
