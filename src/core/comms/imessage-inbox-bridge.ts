import { receiptOwnerChat } from '../agents/chat-owner-ingress.js';
/**
 * RQ-IMSG-BRIDGE-1: private iMessage → local inbox; explicit owner share is separately gated.
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
 * pass. Mason's ordinary texts are never mirrored; an exact agent-chat.share request
 * after native owner verification can publish only its explicitly selected text.
 *
 * Chunked patch transfers (RQ-SWE3-IMSGDEEP-1, imessage-patch-transfer.ts):
 * PATCH-BEGIN/PART/END frames from an allowlisted teammate are consumed by the
 * durable transfer state under <imessage>/patches/ as each row is receipted —
 * the raw frame text is used, not the scrubbed inbox copy — and a completed
 * transfer is sha256-verified before <id>.patch is written. Frames are
 * protocol traffic: the findings mirror skips them and announces each
 * verified artifact instead. A transfer-ledger failure defers the batch just
 * like a teammate-ledger failure; the frame is retried next poll.
 *
 * What the receiver does for us: dedupe inside CHANNEL_DEDUPE_WINDOW_MS,
 * attribution (source `imessage`), the MASON-INBOX.md entry, and the
 * chief-of-staff queue job for commands (createChannelReceiver queues every
 * accepted envelope through cos/intake.ts). Secret-shaped, empty and oversize
 * bodies are refused there, not stored. iMessage opts out of the agent-bus
 * mirror (`publish: null`): Mason's texts stay in local inbox/queue files.
 * Each accepted or deduplicated receipt is also copied into the unified owner
 * thread (comms/owner-thread.ts) — the same record the Telegram, email and
 * Slack receivers get — as a best-effort step that never changes the receipt,
 * the cursor or this result.
 *
 * Acknowledgement: the shared ack text (channel-ack-text.ts) is RECORDED to
 * <runs>/imessage/acks.jsonl. Nonduplicate acknowledgements pass through the
 * self-only outbox; third-party delivery remains denied pending Security review.
 * A nonduplicate ack for a verified-Mason short status ask ("status", "phantom
 * status", ...) instead carries the fixed owner digest from
 * agents/owner-status-reply.ts through the same outbox to the same handle; the
 * receipt, dedupe, cursor and acks.jsonl record are unchanged.
 *
 * Cursor rules: first run baselines to the current max ROWID (history is never
 * replayed). A message advances the cursor once it is receipted or permanently
 * refused. A transient failure (queue/dedupe store unavailable) stops the batch
 * with the cursor just before it, so the next poll retries; dedupe makes the
 * retry safe. Never throws.
 */

import { sendIMessageOutbox } from './imessage-outbox.js';
import { recordTeammateText, senderIdFor } from './imessage-teammate-inbox.js';
import { bridgeTeammateFindings, type FindingsBridgeOptions, type FindingsBridgeReport } from './imessage-findings-bridge.js';
import { recordPatchFrame, sweepPatchTransfers, type PatchFrameOutcome, type PatchSweepReport } from './imessage-patch-transfer.js';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  imessageAllowlist, isVerifiedMasonHandle, imessageStateDir, pollInboundSince, readCursor, readMaxRowId, writeCursor,
  type ChatDbState, type IntakeMsg, type IntakePoll,
} from '../integrations/imessage.js';
import { createChannelReceiver, OPERATOR_SENDER_ID, type ChannelAck, type ChannelEnvelope, type ChannelMessage } from '../fleet/channel-envelope.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import { inboxWriteHealth } from '../fleet/mason-inbox.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import type { AshlrConfig } from '../types.js';

/** Report inbox access without exposing message content or handles. */
export async function imessageInboxHealth(runsDir?: string, busRoot?: string): Promise<{ inboxHealth?: 'missing' | 'permission-denied' }> {
  const health = await inboxWriteHealth(runsDir);
  if (!health) return {};
  alertInboxPermission(busRoot);
  return { inboxHealth: health };
}

function alertInboxPermission(busRoot?: string): void {
  // Fixed envelope and id make repeated health checks idempotent.
  appendBusInbox({ id: 'imessage-owner-inbox-unwritable', from: 'imessage', to: 'mason', priority: 'P0',
    ttl: CHANNEL_BUS_TTL_MS, body: { kind: 'note', text: 'iMessage owner inbox is missing or not writable.' } }, { root: busRoot, reservedHeadroom: true });
}

/** Fixed owner "status" auto-answer for a verified-Mason short ask; the same
 * contract the Slack adapter injects (agents/slack-leader.ts SlackStatusReply). */
export interface IMessageStatusReply {
  /** Exact short owner asks only; anything else keeps the generic ack. */
  ask(text: string): boolean;
  /** Compose the answer for a gated ask; `text` is the owner's ask body. */
  compose(runsDir: string, now: Date, text?: string): Promise<string>;
  /** Sent when compose throws. */
  readonly fallback: string;
}

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
  /** Owner "status" auto-answer seam for tests; the default lazily resolves
   * agents/owner-status-reply.js, whose digest readers stay outside this
   * module's Tier-1 import closure. */
  statusReply?: IMessageStatusReply;
  /** Patch transfer seams for tests; defaults write the real ledger. */
  patchFrame?: (msg: { rowid: number; handle: string; text: string }, opts: { runsDir?: string; now?: () => Date }) => { handled: boolean; outcome: PatchFrameOutcome; id?: string };
  patchSweep?: (opts: { runsDir?: string; now?: () => Date }) => PatchSweepReport;
}

export type IMessageIngestState =
  | 'inbox-permission-denied' | 'ingested' | 'baselined' | 'disabled' | 'unsupported' | 'error' | Exclude<ChatDbState, 'ok'>;

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
  inboxHealth?: 'missing' | 'permission-denied';
  /** Findings mirror outcome; null only when the pass ended before the bus stage. */
  findings: FindingsBridgeReport | null;
  /** Patch transfer outcome: this batch's frame tallies merged with the expiry sweep. */
  patches: PatchIngestReport | null;
}

/** Per-batch frame tallies on top of the sweep report. */
export interface PatchIngestReport extends PatchSweepReport {
  /** Frame rows consumed this batch (all terminal outcomes). */
  frames: number;
  /** Transfers sha256-verified and written to patches/ this batch. */
  completed: number;
  /** Transfers rejected this batch (conflict, hash-mismatch, oversize). */
  rejected: number;
  /** Frame rows refused this batch (malformed, secret-shaped, spent id, cap). */
  refused: number;
  /** Frame rows already in the dedup ring this batch. */
  duplicate: number;
}

export { senderIdFor };

// The status composer's digest readers must not join the Tier-1 import
// closure, so this module never imports them, and a computed import() is not an
// option: the compiled sidecar resolves a computed specifier against its
// virtual FS and always misses (test/sidecar-literal-imports-315.test.ts).
// The CLI entry (src/cli/index.ts, outside the closure and the entry of every
// host: CLI, daemon tick, Leader tick, teammate worker, sidecar) publishes a
// loader built from a literal import under this well-known key. The loader runs
// on the first ack, so it costs nothing at startup. With no loader the ack
// degrades to the generic receipt.
export const IMESSAGE_STATUS_REPLY_LOADER = Symbol.for('ashlr.imessage.statusReplyLoader');
const loadStatusReply = async (): Promise<IMessageStatusReply | null> => {
  try {
    const loader = (globalThis as Record<symbol, unknown>)[IMESSAGE_STATUS_REPLY_LOADER];
    return typeof loader === 'function' ? await (loader as () => Promise<IMessageStatusReply | null>)() : null;
  } catch { return null; }
};

/** Map one allowlisted chat.db row to a canonical channel message. */
export function imessageChannelMessage(msg: IntakeMsg): ChannelMessage | null {
  if (!Number.isSafeInteger(msg.rowid) || msg.rowid <= 0 || !msg.handle.trim()) return null;
  return { channel: 'imessage', verifiedSenderId: senderIdFor(msg.handle), body: msg.text, threadId: String(msg.rowid) };
}

const TRANSIENT = new Set(['write-failed', 'dedupe-store-unavailable', 'full']);

/**
 * Best-effort copy of an authenticated owner receipt into the unified owner
 * thread — the same record receiptLeaderChannel gives the Telegram, email and
 * Slack receivers. The channel receiver already appended the durable inbox
 * entry, so the leader mailbox plug is the always-accept stub noteOwnerReceipt
 * hands the other channels: the thread records the message without a second
 * MASON-INBOX write. The stored senderId is the configured owner identity
 * whenever it names the same verified handle — ownerAllowed compares exactly
 * while intake verifies handles case-insensitively — and owner-thread's own
 * bus mirror is already redacted for iMessage.
 * Dynamic imports keep owner-thread's store closure out of this module's
 * Tier-1 import graph. A miss never changes the receipt, the cursor or result.
 */
async function noteImessageOwnerThread(
  handle: string,
  envelope: ChannelEnvelope,
  context: { runsDir: string; busRoot?: string; now: () => Date },
): Promise<void> {
  try {
    const [{ noteOwnerReceipt }, { fixedOwnerConfigDir, loadOwnerThreadSettings }] = await Promise.all([
      import('./owner-thread.js'),
      import('./owner-channel.js'),
    ]);
    const settings = loadOwnerThreadSettings(fixedOwnerConfigDir());
    const verified = handle.trim();
    const configured = settings.owners.imessage?.trim();
    // ownerAllowed compares exactly while intake verifies handles
    // case-insensitively; the configured owner id is canonical on a match.
    const senderId = configured !== undefined && configured.toLowerCase() === verified.toLowerCase() ? configured : verified;
    const at = Date.parse(envelope.receivedAt);
    await noteOwnerReceipt({
      channel: 'imessage', senderId, text: envelope.body, idempotencyKey: envelope.dedupeKey,
      at: Number.isNaN(at) ? context.now().getTime() : at,
      ...(envelope.threadId === undefined ? {} : { channelRef: envelope.threadId }),
    }, {
      runsDir: context.runsDir, busRoot: context.busRoot, now: () => context.now().getTime(), settings,
      mailbox: { accept: async () => ({ status: 'accepted' as const }) },
    });
  } catch { /* The durable inbox receipt stays authoritative. */ }
}

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
  const result: IMessageIngestResult = { ok: false, state: 'error', scanned: 0, accepted: 0, notMason: 0, teammate: 0, duplicate: 0, refused: 0, deferred: false, cursor: null, findings: null, patches: null };
  try {
    if (cfg.comms?.enabled !== true || imessageAllowlist(cfg).length === 0) return { ...result, state: 'disabled' };
    if ((deps.platform ?? process.platform) !== 'darwin') return { ...result, state: 'unsupported' };
    Object.assign(result, await imessageInboxHealth(deps.runsDir, deps.busRoot));
    const now = deps.now ?? (() => new Date());
    // The findings mirror is best effort and local-only: it never changes a
    // receipt, the cursor or this result's ok/state, and it drains any durable
    // backlog even when this poll found nothing new or could not reach chat.db.
    const findings = (): FindingsBridgeReport | null => {
      try { return (deps.bridgeFindings ?? bridgeTeammateFindings)({ runsDir: deps.runsDir, busRoot: deps.busRoot, now }); }
      catch { return null; }
    };
    // Frame rows consumed during the batch merge with the post-batch expiry
    // sweep; the sweep is best effort and runs on every exit path.
    const frames = { frames: 0, completed: 0, rejected: 0, refused: 0, duplicate: 0 };
    const patches = (): PatchIngestReport | null => {
      try {
        const sweep = (deps.patchSweep ?? sweepPatchTransfers)({ runsDir: deps.runsDir, now });
        return { ...sweep, ...frames };
      } catch { return null; }
    };

    const start = readCursor(deps.runsDir);
    let cursor = start;
    if (cursor === null) {
      const base = await (deps.maxRowId ?? readMaxRowId)();
      if (!base.ok) return { ...result, state: base.state, findings: findings(), patches: patches() };
      writeCursor(base.rowid, deps.runsDir, now);
      return { ...result, ok: true, state: 'baselined', cursor: base.rowid, findings: findings(), patches: patches() };
    }

    const polled = await (deps.poll ?? pollInboundSince)(cursor, cfg);
    if (!polled.ok) return { ...result, state: polled.state, cursor, findings: findings(), patches: patches() };

    const runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    let current = 0;
    let currentHandle = '';
    let currentBody = '';
    // Only the verified-Mason branch below calls receive, so the ack path never
    // resolves a status reply for any other handle.
    const ackText = async (ack: ChannelAck): Promise<string> => {
      const generic = formatChannelAck(ack);
      const reply = deps.statusReply ?? await loadStatusReply();
      if (!reply) return generic;
      let isAsk = false;
      try { isAsk = reply.ask(currentBody); } catch { return generic; }
      if (!isAsk) return generic;
      try { return await reply.compose(runsDir, now(), currentBody); }
      catch { return reply.fallback; }
    };
    const receive = createChannelReceiver({
      allowedSenderIds: new Set(imessageAllowlist(cfg).map(senderIdFor)),
      runsDir: deps.runsDir,
      now: deps.now,
      // iMessage bodies are personal texts: they stay in local inbox/queue files and are
      // never automatically mirrored to the shared agent bus (Textbot handoff #3472).
      publish: null,
      acknowledge: async (ack) => {
        recordAck(ack, current, deps.runsDir, now());
        // A same-channel repeat stays quiet. A duplicate that joined another
        // channel's entry (entryId) is this channel's first word on the order,
        // so it gets its own ack quoting the shared receipt.
        if (ack.status !== 'duplicate' || ack.entryId !== undefined) await sendIMessageOutbox(await ackText(ack), cfg, currentHandle);
      },
    });
    for (const msg of polled.messages) {
      result.scanned++;
      const message = imessageChannelMessage(msg);
      if (!isVerifiedMasonHandle(msg.handle, cfg)) {
        result.notMason++;
        // Keep protocol frames out of the teammate findings mirror.
        const frame = (deps.patchFrame ?? recordPatchFrame)(msg, { runsDir: deps.runsDir, now });
        if (frame.handled) {
          frames.frames++;
          if (frame.outcome === 'completed') frames.completed++;
          else if (frame.outcome === 'rejected') frames.rejected++;
          else if (frame.outcome === 'refused') frames.refused++;
          else if (frame.outcome === 'duplicate') frames.duplicate++;
          else if (frame.outcome === 'unavailable') { result.deferred = true; break; }
        } else if (recordTeammateText(msg, deps.runsDir, now())) {
          result.teammate++;
        } else {
          // A teammate's artifact is not receipted until its local record is durable.
          result.deferred = true;
          break;
        }
      } else if (message) {
        current = msg.rowid;
        currentHandle = msg.handle;
        currentBody = message.body;
        const got = await receive({ ...message, canonicalSenderId: OPERATOR_SENDER_ID });
        if (got.ok) {
          if (got.ack.status === 'duplicate') result.duplicate++; else result.accepted++;
          await noteImessageOwnerThread(msg.handle, got.envelope, { runsDir, busRoot: deps.busRoot, now });
          // Explicit structured share only, after native verified-owner receipt. Ordinary
          // private traffic remains local. A transient group write must retry this row.
          const share = receiptOwnerChat(msg, cfg, { runsDir: deps.runsDir, busRoot: deps.busRoot, now: () => now().getTime() });
          if (share.status === 'retryable') { result.deferred = true; break; }
          if (share.status === 'refused') result.refused++;
        } else if (got.reason === 'inbox-permission-denied') {
          result.inboxHealth = 'permission-denied';
          alertInboxPermission(deps.busRoot);
          break;
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
    return { ...result, ok: !result.deferred && result.inboxHealth !== 'permission-denied', state: result.inboxHealth === 'permission-denied' ? 'inbox-permission-denied' : 'ingested', cursor, findings: findings(), patches: patches() };
  } catch {
    return result;
  }
}
