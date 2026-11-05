/**
 * RQ-IMSG-BRIDGE-1: iMessage → MASON-INBOX.md / agent bus / chief-of-staff queue.
 *
 * Third intake channel beside email and Telegram. integrations/imessage.ts reads
 * chat.db read-only and hands back allowlisted messages past a persisted
 * message.ROWID cursor; this bridge gives each one the shared channel-receiver
 * treatment (fleet/channel-envelope.ts):
 *
 *   imessageChannelMessage(msg)   - pure mapping to channel `imessage`.
 *   ingestIMessages(cfg, deps)    - poll, receipt, advance the cursor.
 *   senderIdFor(handle)           - `imessage:<hash>`; the raw handle never
 *     reaches the inbox, bus or queue.
 *
 * What the receiver does for us: dedupe inside CHANNEL_DEDUPE_WINDOW_MS,
 * attribution (source `imessage`), the MASON-INBOX.md entry, the agent-bus
 * mirror, and the chief-of-staff queue job for commands (createChannelReceiver
 * queues every accepted envelope through cos/intake.ts). Secret-shaped, empty
 * and oversize bodies are refused there, not stored.
 *
 * Acknowledgement: the shared ack text (channel-ack-text.ts) is RECORDED to
 * <runs>/imessage/acks.jsonl and never sent. Sending a reply is the job of
 * RQ-IMSG-REPLY-1; until then this module has no send path at all.
 *
 * Cursor rules: first run baselines to the current max ROWID (history is never
 * replayed). A message advances the cursor once it is receipted or permanently
 * refused. A transient failure (queue/dedupe store unavailable) stops the batch
 * with the cursor just before it, so the next poll retries; dedupe makes the
 * retry safe. Never throws.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  imessageAllowlist, imessageStateDir, pollInboundSince, readCursor, readMaxRowId, writeCursor, commsEnabled,
  type ChatDbState, type IntakeMsg, type IntakePoll,
} from '../integrations/imessage.js';
import { createChannelReceiver, OPERATOR_SENDER_ID, type ChannelAck, type ChannelMessage } from '../fleet/channel-envelope.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import type { AshlrConfig } from '../types.js';

export interface IMessageIngestDeps {
  /** Shared runs context (inbox, receipts, queue, cursor). Default ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => Date;
  /** chat.db seams for tests. */
  poll?: (afterRowId: number, cfg: AshlrConfig) => Promise<IntakePoll>;
  maxRowId?: typeof readMaxRowId;
}

export type IMessageIngestState =
  | 'ingested' | 'baselined' | 'disabled' | 'unsupported' | 'error' | Exclude<ChatDbState, 'ok'>;

export interface IMessageIngestResult {
  ok: boolean;
  state: IMessageIngestState;
  scanned: number;
  accepted: number;
  duplicate: number;
  refused: number;
  /** Stopped early on a transient failure; the rest is retried next poll. */
  deferred: boolean;
  cursor: number | null;
}

/** Stable, non-reversible-at-a-glance sender id so handles stay out of stored envelopes. */
export function senderIdFor(handle: string): string {
  return `imessage:${createHash('sha256').update(handle.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** Map one allowlisted chat.db row to a canonical channel message. */
export function imessageChannelMessage(msg: IntakeMsg): ChannelMessage | null {
  if (!Number.isSafeInteger(msg.rowid) || msg.rowid <= 0 || !msg.handle.trim()) return null;
  return { channel: 'imessage', verifiedSenderId: senderIdFor(msg.handle), body: msg.text, threadId: String(msg.rowid) };
}

const TRANSIENT = new Set(['write-failed', 'dedupe-store-unavailable', 'full']);

function recordAck(ack: ChannelAck, rowid: number, runsDir: string | undefined, at: Date): void {
  try {
    const dir = imessageStateDir(runsDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'acks.jsonl');
    appendFileSync(file, `${JSON.stringify({ at: at.toISOString(), rowid, status: ack.status, receipt: ack.dedupeKey,
      text: formatChannelAck(ack), delivery: 'recorded-not-sent' })}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch { /* the receipt is already durable; the ack record is evidence only */ }
}

export async function ingestIMessages(cfg: AshlrConfig, deps: IMessageIngestDeps = {}): Promise<IMessageIngestResult> {
  const result: IMessageIngestResult = { ok: false, state: 'error', scanned: 0, accepted: 0, duplicate: 0, refused: 0, deferred: false, cursor: null };
  try {
    if (!commsEnabled(cfg) || imessageAllowlist(cfg).length === 0) return { ...result, state: 'disabled' };
    if (process.platform !== 'darwin') return { ...result, state: 'unsupported' };
    const now = deps.now ?? (() => new Date());

    const start = readCursor(deps.runsDir);
    let cursor = start;
    if (cursor === null) {
      const base = await (deps.maxRowId ?? readMaxRowId)();
      if (!base.ok) return { ...result, state: base.state };
      writeCursor(base.rowid, deps.runsDir, now);
      return { ...result, ok: true, state: 'baselined', cursor: base.rowid };
    }

    const polled = await (deps.poll ?? pollInboundSince)(cursor, cfg);
    if (!polled.ok) return { ...result, state: polled.state, cursor };

    let current = 0;
    const receive = createChannelReceiver({
      allowedSenderIds: new Set(imessageAllowlist(cfg).map(senderIdFor)),
      runsDir: deps.runsDir,
      now: deps.now,
      acknowledge: async (ack) => recordAck(ack, current, deps.runsDir, now()),
    });
    for (const msg of polled.messages) {
      result.scanned++;
      const message = imessageChannelMessage(msg);
      if (message) {
        current = msg.rowid;
        const got = await receive({ ...message, canonicalSenderId: OPERATOR_SENDER_ID });
        if (got.ok) {
          if (got.ack.status === 'duplicate') result.duplicate++; else result.accepted++;
        } else if (TRANSIENT.has(got.reason)) {
          result.deferred = true;
          break;
        } else {
          result.refused++;
        }
      } else {
        result.refused++;
      }
      cursor = msg.rowid;
    }
    if (cursor !== start) writeCursor(cursor, deps.runsDir, now);
    return { ...result, ok: !result.deferred, state: 'ingested', cursor };
  } catch {
    return result;
  }
}
