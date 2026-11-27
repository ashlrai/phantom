/**
 * Read-side view of the teammate responder's receipt store
 * (<imessageStateDir>/teammate-replies.json).
 *
 * `runTeammateResponder` (imessage-teammate-worker.ts) persists one receipt
 * per picked-up teammate text — `replies[]` rows cycling
 * claimed → drafted → sending → sent|suppressed — and one receipt per
 * teammate work request — `jobs[]` rows cycling prepared → appending →
 * queued as the RQ-DOT prompt is appended to queue/ready.tsv. Between
 * passes the file is the only record of which attempts are still owed a
 * send outcome and which queue appends never confirmed; until now the only
 * readers were the responder itself and an improve prompt that tells an
 * agent to hand-parse the JSON.
 *
 * This is a leaf module — no transport, model, lock or queue imports — so
 * read-only observers (the unified comms inbox's `teammate-responder`
 * source) never pull the responder's graph. The worker imports the schema
 * back, so `isTeammateResponderStore` is the single validation both sides
 * apply: a store the responder would refuse is 'unavailable' here too,
 * never a partial parse passed off as fact.
 *
 * Honesty rules, same as every other store read:
 *  - Read-only. The file is read once through readStableRegularFile's
 *    anchored, size-capped, change-checked read; nothing is written and no
 *    lock is taken — the responder's own atomic rename keeps each read
 *    consistent.
 *  - Absent file is 'missing' (the responder has not saved receipts yet —
 *    verified-empty, pending 0). An unreadable, oversized, non-regular or
 *    schema-invalid file is 'unavailable' with pending unknown, never an
 *    empty receipt list passed off as fact.
 *  - `text` (the drafted reply body) and `receipt` (the send receipt) stay
 *    in the store for the responder's reconcile path; this read surfaces
 *    state, timing and attempt counts only — message bodies never reach an
 *    inbox item.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { imessageStateDir } from '../integrations/imessage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import type { TeamMessageReceipt } from './imessage-teammate-transport.js';

/** Same byte cap the responder applies to its own read and rewrite. */
const RECEIPTS_MAX_BYTES = 1024 * 1024;

export const TEAMMATE_REPLY_STATES = ['claimed', 'drafted', 'sending', 'sent', 'suppressed'] as const;
export type TeammateReplyState = (typeof TEAMMATE_REPLY_STATES)[number];

export const TEAMMATE_WORK_STATES = ['prepared', 'appending', 'queued'] as const;
export type TeammateWorkState = (typeof TEAMMATE_WORK_STATES)[number];

/** Repos a teammate work request may name — the responder's own whitelist. */
export const TEAMMATE_WORK_REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin'] as const;
/** Lanes a teammate work request may select — the responder's own whitelist. */
export const TEAMMATE_WORK_LANES = ['codex-personal', 'claude', 'devin', 'claude-api', 'codex-local', 'omlx'] as const;

export interface TeammateReplyReceipt {
  rowid: number;
  senderId: string;
  state: TeammateReplyState;
  at: number;
  claimUntil: number;
  text?: string;
  attemptedAt?: number;
  sendAttempts?: number;
  receipt?: TeamMessageReceipt;
  tries?: number;
  ack?: boolean;
}

export interface TeammateWorkReceipt {
  hash: string;
  id: string;
  repo: string;
  lane: string;
  at: number;
  state: TeammateWorkState;
}

export interface TeammateResponderStore {
  v: 1;
  replies: TeammateReplyReceipt[];
  jobs?: TeammateWorkReceipt[];
  scanAfter?: number;
  scanCeiling?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The exact predicate `runTeammateResponder` applies before it trusts the
 * store — same bounds, same field checks, same failure verdict. Kept here
 * so the read-only observers and the writer can never disagree about what
 * a valid store is. Fields the writer itself does not check (`receipt`,
 * `ack`) stay unchecked here too.
 */
export function isTeammateResponderStore(value: unknown): value is TeammateResponderStore {
  if (!isRecord(value) || value['v'] !== 1) return false;
  const replies = value['replies'];
  if (!Array.isArray(replies) || replies.length > 256) return false;
  for (const row of replies) {
    if (!isRecord(row)) return false;
    if (!Number.isSafeInteger(row['rowid']) || (row['rowid'] as number) < 1) return false;
    if (!/^imessage:[a-f0-9]{16}$/.test(row['senderId'] as string)) return false;
    if (!(TEAMMATE_REPLY_STATES as readonly string[]).includes(row['state'] as string)) return false;
    if (!Number.isFinite(row['at']) || !Number.isFinite(row['claimUntil'])) return false;
    if (row['text'] !== undefined && (typeof row['text'] !== 'string' || (row['text'] as string).length > 4000)) return false;
    if (row['attemptedAt'] !== undefined && !Number.isFinite(row['attemptedAt'])) return false;
    if (row['sendAttempts'] !== undefined && (!Number.isSafeInteger(row['sendAttempts']) || (row['sendAttempts'] as number) < 0)) return false;
    if (row['tries'] !== undefined && !Number.isSafeInteger(row['tries'])) return false;
  }
  const scanAfter = value['scanAfter'];
  if (scanAfter !== undefined && (!Number.isSafeInteger(scanAfter) || (scanAfter as number) < 0)) return false;
  const scanCeiling = value['scanCeiling'];
  if (scanCeiling !== undefined && (!Number.isSafeInteger(scanCeiling) || (scanCeiling as number) < 1)) return false;
  const jobs = value['jobs'];
  if (jobs === undefined) return true;
  if (!Array.isArray(jobs) || jobs.length > 512) return false;
  for (const job of jobs) {
    if (!isRecord(job)) return false;
    if (!/^[a-f0-9]{64}$/.test(job['hash'] as string)) return false;
    if (!/^RQ-DOT-[a-z0-9-]+-\d+$/.test(job['id'] as string)) return false;
    if (!(TEAMMATE_WORK_REPOS as readonly string[]).includes(job['repo'] as string)) return false;
    if (!(TEAMMATE_WORK_LANES as readonly string[]).includes(job['lane'] as string)) return false;
    if (!Number.isSafeInteger(job['at']) || (job['at'] as number) < 0) return false;
    if (!(TEAMMATE_WORK_STATES as readonly string[]).includes(job['state'] as string)) return false;
  }
  return true;
}

/** The resolved receipts read: a source state plus every stored reply and work receipt. Non-'ok' states carry empty lists — the pending total is reported by the caller, never guessed here. */
export interface TeammateResponderRead {
  state: 'missing' | 'unavailable' | 'ok';
  replies: readonly TeammateReplyReceipt[];
  jobs: readonly TeammateWorkReceipt[];
}

/**
 * Read `<imessageStateDir(runsDir)>/teammate-replies.json` once. 'missing'
 * is a verified-absent store (the responder has not saved receipts yet);
 * 'unavailable' covers every read or schema failure — an unreadable or
 * invalid store is never an empty receipt list passed off as fact.
 */
export function readTeammateResponderReceipts(options: { runsDir?: string } = {}): TeammateResponderRead {
  const none = (state: TeammateResponderRead['state']): TeammateResponderRead => ({ state, replies: [], jobs: [] });
  const dir = imessageStateDir(options.runsDir);
  const file = join(dir, 'teammate-replies.json');
  if (!existsSync(file)) return none('missing');
  const result = readStableRegularFile(file, { anchorPath: dir, maxFileBytes: RECEIPTS_MAX_BYTES, remainingBytes: RECEIPTS_MAX_BYTES });
  // existsSync already proved presence; every read failure — including a file
  // that vanished mid-read, which reports 'io-error' — is honestly unavailable.
  if (!result.ok) return none('unavailable');
  let parsed: unknown;
  try { parsed = JSON.parse(result.text); } catch { return none('unavailable'); }
  if (!isTeammateResponderStore(parsed)) return none('unavailable');
  return { state: 'ok', replies: parsed.replies, jobs: parsed.jobs ?? [] };
}
