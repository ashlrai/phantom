/**
 * leader-replies-ledger.ts: the read side of the leader-reply iMessage send
 * ledger — `<imessageStateDir>/leader-sent.jsonl`, the append-only
 * `{at, hash, status}` journal `sendLeaderReplies` writes on every live
 * pass (src/core/comms/imessage-replies.ts's caller contract: 'pending'
 * before the transport call, then 'sent' or 'failed'; 'baseline' rows are
 * written once at ledger creation beside the 'start' marker; dry-run and
 * disabled passes write nothing).
 *
 * Until now the ledger's only readers were the writer's own `readClaimed`
 * dedupe scan and the recurrence-gated improve backlog — so the CURRENT
 * pending surface had no listing: a reply whose last recorded outcome is
 * `failed` waits for the next live pass's retry, and a hash whose last row
 * is `pending` past the in-flight bound is an orphaned dead letter
 * (`readClaimed` counts anything but `failed` as claimed, so no pass ever
 * retries it and the reply is never texted). This module projects exactly
 * those two classes for the unified comms inbox.
 *
 * Honesty rules:
 *  - Read-only. The ledger is read once through a bounded no-follow tail at
 *    the writer's own read bound; the outbox journals are read through the
 *    same bounded `readOutboxEntries` call the sender uses, and only when
 *    at least one reply is pending. Nothing is written and no lock,
 *    process or network is touched.
 *  - Last-status-per-hash mirrors `readClaimed`'s file-order fold, so the
 *    projection can never disagree with what the next pass will do: `sent`
 *    and `baseline` are resolved claims and never list, a fresh `pending`
 *    may still be in flight and never lists, `failed` lists as 'failed'
 *    (retry owed), and a `pending` older than the staleness bound lists as
 *    'orphaned' (claimed forever, never retried).
 *  - The tail bound IS the writer's own read bound (LEDGER_MAX_BYTES), so
 *    `truncated` means exactly the oversize condition the writer itself
 *    fails closed on; hashes whose rows all sit before the window are
 *    unseen — pending is a stated lower bound under 'degraded', never a
 *    fabricated total.
 *  - Rows count only under the writer's contract: a parseable ISO `at`, a
 *    'start' marker or 64-hex replyTextHash, and the closed status
 *    vocabulary. A malformed line is skipped, never guessed.
 *  - Hashes are reply-content fingerprints — counted and carried as item
 *    identity, never emitted as text. Reply text resolves only through the
 *    outbox journals the leader already writes for Mason; when the bounded
 *    read no longer holds a matching entry the item says so instead of
 *    inventing one.
 *  - Never throws: an absent ledger is 'missing' (verified empty — no live
 *    pass ever recorded), an existing but unreadable or non-regular file
 *    is 'unavailable', and any internal failure degrades to 'unavailable'
 *    rather than an empty list passed off as fact.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { imessageStateDir } from '../integrations/imessage.js';
import { readOutboxEntries, replyTextHash, type OutboxEntry } from '../fleet/mason-outbox.js';
import { readPrivateFileTailCapped } from '../verse/preferences.js';

/** The ledger filename inside imessageStateDir — the writer's LEDGER_FILE. */
export const LEADER_REPLIES_LEDGER_FILE = 'leader-sent.jsonl';
/**
 * The writer's whole-file read bound: readClaimed reads the FIRST
 * LEDGER_MAX_BYTES via readPrivateFileCapped and throws 'ledger
 * unreadable' past it. Duplicated rather than imported from
 * src/core/comms/imessage-leader-replies.ts so the send module stays out
 * of this read's import closure — if the writer's bound moves, move this
 * with it (the same convention improve/leader-replies-backlog.ts keeps).
 */
const LEDGER_MAX_BYTES = 1024 * 1024;
/**
 * A 'pending' row younger than this may still be in flight — the send is
 * one transport call and the outcome row lands right behind it. Past it, a
 * hash whose last status is still 'pending' is an orphan: the writer died
 * or threw mid-send and readClaimed now claims the reply forever. Mirrors
 * LEADER_REPLIES_ORPHAN_STALE_MS in improve/leader-replies-backlog.ts —
 * the two readers must agree on what "still in flight" means.
 */
export const LEADER_REPLIES_ORPHAN_STALE_MS = 60 * 60 * 1000;
/** The same entry bound `sendLeaderReplies` reads when it looks for fresh replies. */
const OUTBOX_RESOLVE_LIMIT = 200;
/** The writer's hash shapes: replyTextHash's sha256 hex, or the 'start' ledger-creation marker. */
const HASH_RE = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['pending', 'sent', 'failed', 'baseline']);
type LedgerStatus = 'pending' | 'sent' | 'failed' | 'baseline';

/** One reply hash whose delivery is still owed, projected for the inbox. */
export interface LeaderReplyPending {
  /** The reply-content fingerprint — item identity, never displayed as text. */
  readonly hash: string;
  /** 'failed': last outcome is a recorded send failure, retried next live pass. 'orphaned': last row is a stale 'pending' claim no outcome ever resolved. */
  readonly state: 'failed' | 'orphaned';
  /** ISO of the first recorded send attempt seen for the hash — first pending row, else first failed row, else the last row; null only when no row's `at` parsed (impossible under the row contract, kept for seam safety). */
  readonly since: string | null;
  /** ISO of the hash's last status row — when the pending state was last evidenced. */
  readonly lastAt: string | null;
  /** Recorded 'failed' outcome rows for the hash inside the read window — a lower bound when the tail truncated. */
  readonly failedAttempts: number;
  /** ISO of the pending claim row (orphaned only) — when the send was claimed and never resolved. */
  readonly claimedAt: string | null;
  /** Newest outbox entry carrying this reply text, when the bounded read still holds it; null when unresolved — the item then says the text is not in the current outbox read. */
  readonly reply: { readonly at: string; readonly text: string } | null;
}

/** The resolved leader-reply ledger read: a unified source state plus every reply hash still owed a proven delivery. */
export interface LeaderRepliesLedgerRead {
  state: 'healthy' | 'missing' | 'degraded' | 'unavailable';
  items: readonly LeaderReplyPending[];
}

interface HashFold {
  lastStatus: LedgerStatus;
  lastAtMs: number;
  firstPendingAtMs: number | null;
  minFailedAtMs: number | null;
  failedCount: number;
}

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Read the send ledger and project the replies still owed a proven
 * delivery. `now` anchors the in-flight staleness bound; `runsDir` resolves
 * imessageStateDir and the outbox journals exactly like the sender.
 */
export async function readLeaderRepliesLedger(
  options: { runsDir?: string; now?: () => number } = {},
): Promise<LeaderRepliesLedgerRead> {
  try {
    const file = join(imessageStateDir(options.runsDir), LEADER_REPLIES_LEDGER_FILE);
    if (!existsSync(file)) return { state: 'missing', items: [] };
    const read = readPrivateFileTailCapped(file, LEDGER_MAX_BYTES);
    if (read === null) return { state: 'unavailable', items: [] };

    // Last-status-per-hash over every on-contract row, the same fold
    // readClaimed applies — file order is append order, so the last row
    // seen for a hash is its current claim state.
    const folds = new Map<string, HashFold>();
    for (const line of read.text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let value: unknown;
      try { value = JSON.parse(trimmed); } catch { continue; }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const atMs = typeof row['at'] === 'string' ? Date.parse(row['at']) : NaN;
      const hash = row['hash'];
      const status = row['status'];
      if (!Number.isFinite(atMs) || typeof hash !== 'string' ||
        (hash !== 'start' && !HASH_RE.test(hash)) ||
        typeof status !== 'string' || !STATUSES.has(status)) continue;
      if (hash === 'start') continue;
      const fold = folds.get(hash) ?? {
        lastStatus: status as LedgerStatus, lastAtMs: atMs,
        firstPendingAtMs: null, minFailedAtMs: null, failedCount: 0,
      };
      fold.lastStatus = status as LedgerStatus;
      fold.lastAtMs = atMs;
      if (status === 'pending') {
        fold.firstPendingAtMs = fold.firstPendingAtMs === null ? atMs : Math.min(fold.firstPendingAtMs, atMs);
      } else if (status === 'failed') {
        fold.minFailedAtMs = fold.minFailedAtMs === null ? atMs : Math.min(fold.minFailedAtMs, atMs);
        fold.failedCount += 1;
      }
      folds.set(hash, fold);
    }

    const nowMs = (options.now ?? Date.now)();
    const pending = new Map<string, HashFold>();
    for (const [hash, fold] of folds) {
      if (fold.lastStatus === 'failed') pending.set(hash, fold);
      else if (fold.lastStatus === 'pending' && nowMs - fold.lastAtMs > LEADER_REPLIES_ORPHAN_STALE_MS) pending.set(hash, fold);
    }
    if (pending.size === 0) {
      return { state: read.truncated ? 'degraded' : 'healthy', items: [] };
    }

    // Resolve each owed hash to the newest outbox entry carrying the same
    // reply text — the sender claims by text hash, so identical texts share
    // one pending unit and the newest posting is the best identifier. An
    // outbox read failure never fails the source: the ledger is the
    // authority for what is owed, the journals only name it.
    const replies = new Map<string, OutboxEntry>();
    try {
      const { entries } = await readOutboxEntries({ runsDir: options.runsDir, limit: OUTBOX_RESOLVE_LIMIT });
      for (const entry of entries) {
        const hash = replyTextHash(entry.text);
        if (pending.has(hash)) replies.set(hash, entry);
      }
    } catch { /* unresolved replies stay unnamed, never invented */ }

    const items: LeaderReplyPending[] = [...pending.entries()].map(([hash, fold]) => {
      const orphaned = fold.lastStatus === 'pending';
      const entry = replies.get(hash) ?? null;
      const sinceMs = fold.firstPendingAtMs ?? fold.minFailedAtMs ?? fold.lastAtMs;
      return {
        hash,
        state: orphaned ? 'orphaned' as const : 'failed' as const,
        since: isoOrNull(sinceMs),
        lastAt: isoOrNull(fold.lastAtMs),
        failedAttempts: fold.failedCount,
        claimedAt: orphaned ? isoOrNull(fold.lastAtMs) : null,
        reply: entry === null ? null : { at: entry.at, text: entry.text },
      };
    });
    items.sort((a, b) => {
      const am = a.since === null ? 0 : Date.parse(a.since);
      const bm = b.since === null ? 0 : Date.parse(b.since);
      return bm - am || a.hash.localeCompare(b.hash);
    });
    return { state: read.truncated ? 'degraded' : 'healthy', items };
  } catch {
    return { state: 'unavailable', items: [] };
  }
}
