/**
 * RQ-IMSG-BRIDGE-1: iMessage → MASON-INBOX.md / chief-of-staff queue (never the agent bus).
 *
 * Third intake channel beside email and Telegram. integrations/imessage.ts reads
 * chat.db read-only and hands back allowlisted messages past a persisted
 * message.ROWID cursor; only the verified Mason handle is receipted as operator
 * input through the shared channel receiver (fleet/channel-envelope.ts):
 *
 *   imessageChannelMessage(msg)   - pure mapping to channel `imessage`.
 *   ingestIMessages(cfg, deps)    - poll, receipt, advance the cursor.
 *   senderIdFor(handle)           - `imessage:<hash>`; the raw handle never
 *     reaches the inbox, bus or queue (re-exported from imessage-teammate-inbox).
 *
 * An allowlisted sender that is not the verified Mason handle is still counted
 * (`notMason`) and is now also kept in the local teammate inbox
 * (imessage-teammate-inbox.ts; `ashlr fleet teammate-texts` lists it). Teammate
 * texts never reach MASON-INBOX.md or the queue; after the batch commits, the
 * findings bridge (imessage-findings-bridge.ts) mirrors each durable teammate
 * row to the local agent bus on the `teammate.findings` topic as an untrusted
 * `note` envelope, deduped by rowid. The mirror is best effort and changes no
 * receipt: a store-side failure only leaves `findings.pending` for the next
 * pass. Mason's own texts are never mirrored.
 *
 * What the receiver does for us: dedupe inside CHANNEL_DEDUPE_WINDOW_MS,
 * attribution (source `imessage`), the MASON-INBOX.md entry, and the
 * chief-of-staff queue job for commands (createChannelReceiver queues every
 * accepted envelope through cos/intake.ts). Secret-shaped, empty and oversize
 * bodies are refused there, not stored. iMessage opts out of the agent-bus
 * mirror (`publish: null`): Mason's texts stay in local inbox/queue files.
 *
 * Acknowledgement: the shared ack text (channel-ack-text.ts) is RECORDED to
 * <runs>/imessage/acks.jsonl. Nonduplicate acknowledgements pass through the
 * self-only outbox; third-party delivery remains denied pending Security review.
 *
 * Cursor rules: first run baselines to the current max ROWID (history is never
 * replayed). A message advances the cursor once it is receipted or permanently
 * refused. A transient failure (queue/dedupe store unavailable) stops the batch
 * with the cursor just before it, so the next poll retries; dedupe makes the
 * retry safe. Never throws.
 */

import { sendIMessageOutbox } from './imessage-outbox.js';
import { recordTeammateText, senderIdFor } from './imessage-teammate-inbox.js';
import { recordPatchFrame, sweepPatchTransfers } from './imessage-patch-transfer.js';
import { bridgeTeammateFindings, type FindingsBridgeOptions, type FindingsBridgeReport } from './imessage-findings-bridge.js';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  imessageAllowlist, isVerifiedMasonHandle, imessageStateDir, pollInboundSince, readCursor, readMaxRowId, writeCursor,
  type ChatDbState, type IntakeMsg, type IntakePoll,
} from '../integrations/imessage.js';
import { createChannelReceiver, OPERATOR_SENDER_ID, type ChannelAck, type ChannelMessage } from '../fleet/channel-envelope.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import type { AshlrConfig } from '../types.js';

export interface IMessageIngestDeps {
  /** Shared runs context (inbox, receipts, queue, cursor). Default ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => Date;
  /** Intake availability seam; never changes the native transport or filesystem platform. */
  platform?: NodeJS.Platform;
  /** chat.db seams for tests. */
  poll?: (afterRowId: number, cfg: AshlrConfig) => Promise<IntakePoll>;
  maxRowId?: typeof readMaxRowId;
  /** Private bus store root for the findings mirror; default the canonical store. */
  busRoot?: string;
  /** Findings bridge seam for tests; default the real pass. */
  bridgeFindings?: (options: FindingsBridgeOptions) => FindingsBridgeReport;
}

export type IMessageIngestState =
  | 'ingested' | 'baselined' | 'disabled' | 'unsupported' | 'error' | Exclude<ChatDbState, 'ok'>;

export interface IMessageIngestResult {
  ok: boolean;
  state: IMessageIngestState;
  scanned: number;
  accepted: number;
  notMason: number;
  /** Allowlisted non-Mason texts recorded to the local teammate inbox. */
  teammate: number;
  duplicate: number;
  refused: number;
  /** Stopped early on a transient failure; the rest is retried next poll. */
  deferred: boolean;
  cursor: number | null;
  /** Findings mirror outcome; null only when the pass ended before the bus stage. */
  findings: FindingsBridgeReport | null;
}

export { senderIdFor };

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
  const result: IMessageIngestResult = { ok: false, state: 'error', scanned: 0, accepted: 0, notMason: 0, teammate: 0, duplicate: 0, refused: 0, deferred: false, cursor: null, findings: null };
  try {
    if (cfg.comms?.enabled !== true || imessageAllowlist(cfg).length === 0) return { ...result, state: 'disabled' };
    if ((deps.platform ?? process.platform) !== 'darwin') return { ...result, state: 'unsupported' };
    const now = deps.now ?? (() => new Date());
    // The findings mirror is best effort and local-only: it never changes a
    // receipt, the cursor or this result's ok/state, and it drains any durable
    // backlog even when this poll found nothing new or could not reach chat.db.
    const findings = (): FindingsBridgeReport | null => {
      try { return (deps.bridgeFindings ?? bridgeTeammateFindings)({ runsDir: deps.runsDir, busRoot: deps.busRoot, now }); }
      catch { return null; }
    };

    const start = readCursor(deps.runsDir);
    let cursor = start;
    if (cursor === null) {
      const base = await (deps.maxRowId ?? readMaxRowId)();
      if (!base.ok) return { ...result, state: base.state, findings: findings() };
      writeCursor(base.rowid, deps.runsDir, now);
      return { ...result, ok: true, state: 'baselined', cursor: base.rowid, findings: findings() };
    }

    const polled = await (deps.poll ?? pollInboundSince)(cursor, cfg);
    if (!polled.ok) return { ...result, state: polled.state, cursor, findings: findings() };

    let current = 0;
    let currentHandle = '';
    const receive = createChannelReceiver({
      allowedSenderIds: new Set(imessageAllowlist(cfg).map(senderIdFor)),
      runsDir: deps.runsDir,
      now: deps.now,
      // iMessage bodies are personal texts: they stay in local inbox/queue files and are
      // never mirrored to the shared agent bus (Textbot handoff #3472).
      publish: null,
      acknowledge: async (ack) => {
        recordAck(ack, current, deps.runsDir, now());
        if (ack.status !== 'duplicate') await sendIMessageOutbox(formatChannelAck(ack), cfg, currentHandle);
      },
    });
    for (const msg of polled.messages) {
      result.scanned++;
      const message = imessageChannelMessage(msg);
      if (!isVerifiedMasonHandle(msg.handle, cfg)) {
        result.notMason++;
        // Protocol frames stay in the private transfer store, never the findings mirror.
        // A failed ledger write must leave the cursor before this frame for retry.
        const frame = recordPatchFrame(msg, { runsDir: deps.runsDir, now });
        if (frame.handled) {
          if (frame.outcome === 'unavailable') { result.deferred = true; break; }
        } else if (recordTeammateText(msg, deps.runsDir, now())) result.teammate++;
        else {
          // A teammate's artifact is not receipted until its local record is durable.
          result.deferred = true;
          break;
        }
      } else if (message) {
        current = msg.rowid;
        currentHandle = msg.handle;
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
    sweepPatchTransfers({ runsDir: deps.runsDir, now });
    return { ...result, ok: !result.deferred, state: 'ingested', cursor, findings: findings() };
  } catch {
    return result;
  }
}
