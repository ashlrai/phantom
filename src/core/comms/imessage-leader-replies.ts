/**
 * iMessage leader replies: the outbound half of the two-way Leader channel.
 *
 * Reads the leader's own replies (leader/MASON-OUTBOX.md entries and the
 * "Reply for Mason" lines in leader/PLAN-LOG.md) and texts each one to Mason's
 * verified handle, once, tracked in <runs>/imessage/leader-sent.jsonl.
 *
 * Rules:
 *   - The only destination is cfg.comms.imessageHandle. Nothing else is ever a
 *     target, and the transport refuses any other handle as well.
 *   - Dry run is the default. Real sends need cfg.comms.leaderRepliesSend === true.
 *     A dry run writes nothing, so turning sends on later still sends them.
 *   - The first live pass on a fresh ledger only marks the existing replies as
 *     already seen (`baseline`), so old history is never texted out.
 *   - A reply is claimed (`pending`) before the send, so a crash cannot cause a
 *     second text. A failed send writes `failed`, which frees it for a retry.
 *   - The ledger stores a hash of the reply, never its text.
 *   - A live pass holds leader-replies.lock, so the CLI poll and the sidecar
 *     worker can never read the same ledger state and text a reply twice.
 * Never throws.
 */
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { imessageStateDir, isVerifiedMasonHandle, sendIMessage } from '../integrations/imessage.js';
import { readOutboxEntries, replyTextHash, type OutboxEntry } from '../fleet/mason-outbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import type { AshlrConfig } from '../types.js';

/** At most this many replies leave in one pass; a backlog drains over a few passes. */
export const LEADER_REPLY_BATCH = 3;
const MAX_TEXT_CHARS = 1500;
const LEDGER_MAX_BYTES = 1024 * 1024;
const LEDGER_FILE = 'leader-sent.jsonl';
const LOCK_FILE = 'leader-replies.lock';

type LedgerStatus = 'pending' | 'sent' | 'failed' | 'baseline';

export interface LeaderReplyDeps {
  runsDir?: string;
  now?: () => Date;
  /** Reply source seam for tests; default reads the leader journals under runsDir. */
  readReplies?: () => Promise<OutboxEntry[]>;
  /** Bridge seam for tests; default is the guarded iMessage transport. */
  send?: (text: string, cfg: AshlrConfig, to: string) => Promise<{ ok: boolean }>;
}

export type LeaderReplyState = 'sent' | 'dry-run' | 'disabled' | 'unverified-handle' | 'baselined' | 'busy' | 'error';

export interface LeaderReplyResult {
  state: LeaderReplyState;
  dryRun: boolean;
  /** Replies not yet in the ledger. */
  waiting: number;
  sent: number;
  failed: number;
}

export const leaderRepliesSendEnabled = (cfg: AshlrConfig): boolean =>
  (cfg.comms as { leaderRepliesSend?: unknown } | undefined)?.leaderRepliesSend === true;

function ledgerPath(runsDir?: string): string {
  return join(imessageStateDir(runsDir), LEDGER_FILE);
}

/** Hashes already claimed. The last line for a hash wins, so `failed` re-opens it. */
function readClaimed(runsDir?: string): Set<string> | null {
  const file = ledgerPath(runsDir);
  if (!existsSync(file)) return null;
  const state = new Map<string, LedgerStatus>();
  const read = readPrivateFileCapped(file, LEDGER_MAX_BYTES);
  if (!read || read.truncated) throw new Error('ledger unreadable'); // fail closed: never resend on a bad ledger
  for (const line of read.text.split('\n')) {
    try {
      const row = JSON.parse(line) as { hash?: unknown; status?: unknown };
      if (typeof row.hash === 'string' && typeof row.status === 'string') state.set(row.hash, row.status as LedgerStatus);
    } catch { /* skip a torn line */ }
  }
  return new Set([...state].filter(([, status]) => status !== 'failed').map(([hash]) => hash));
}

function record(runsDir: string | undefined, hash: string, status: LedgerStatus, at: Date): void {
  const file = ledgerPath(runsDir);
  appendFileSync(file, `${JSON.stringify({ at: at.toISOString(), hash, status })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function sendLeaderReplies(cfg: AshlrConfig, deps: LeaderReplyDeps = {}): Promise<LeaderReplyResult> {
  const dryRun = !leaderRepliesSendEnabled(cfg);
  const result: LeaderReplyResult = { state: 'error', dryRun, waiting: 0, sent: 0, failed: 0 };
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    const to = cfg.comms?.imessageHandle;
    if (cfg.comms?.enabled !== true || typeof to !== 'string' || !to.trim()) return { ...result, state: 'disabled' };
    // Defence in depth: the destination must be the verified Mason handle, always.
    if (!isVerifiedMasonHandle(to, cfg)) return { ...result, state: 'unverified-handle' };

    if (!dryRun) {
      // A dry run writes nothing; only a live pass creates the state dir and takes the lock.
      const dir = imessageStateDir(deps.runsDir);
      ensurePrivateDirectory(dir);
      lock = acquireLocalStoreLockWithOutcome(join(dir, LOCK_FILE), 0, { anchorPath: dir });
      if (lock.state !== 'acquired') return { ...result, state: 'busy' };
    }

    const now = deps.now ?? (() => new Date());
    const replies = deps.readReplies
      ? await deps.readReplies()
      : (await readOutboxEntries({ runsDir: deps.runsDir, limit: 200 })).entries;
    const items = replies
      .map((entry) => ({ hash: replyTextHash(entry.text), text: scrubSecrets(entry.text).trim() }))
      .filter((item) => item.text !== '');

    const claimed = readClaimed(deps.runsDir);
    const seen = new Set<string>();
    const fresh = items.filter((item) => {
      if (seen.has(item.hash) || claimed?.has(item.hash)) return false;
      seen.add(item.hash);
      return true;
    });
    result.waiting = fresh.length;
    if (dryRun) return { ...result, state: 'dry-run' };

    if (claimed === null) {
      // The marker row makes the ledger exist even when there is nothing to mark yet.
      record(deps.runsDir, 'start', 'baseline', now());
      for (const item of fresh) record(deps.runsDir, item.hash, 'baseline', now());
      return { ...result, state: 'baselined', waiting: 0 };
    }

    const send = deps.send ?? sendIMessage;
    // Oldest first, a few at a time.
    for (const item of fresh.slice(0, LEADER_REPLY_BATCH)) {
      record(deps.runsDir, item.hash, 'pending', now());
      const ok = (await send(item.text.slice(0, MAX_TEXT_CHARS), cfg, to)).ok;
      record(deps.runsDir, item.hash, ok ? 'sent' : 'failed', now());
      if (ok) result.sent++; else { result.failed++; break; }
    }
    result.waiting -= result.sent;
    return { ...result, state: 'sent' };
  } catch {
    return result;
  } finally {
    if (lock?.state === 'acquired') releaseLocalStoreLock(lock.lock);
  }
}
