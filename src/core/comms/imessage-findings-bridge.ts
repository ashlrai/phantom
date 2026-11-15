/**
 * RQ-SWE3-DOTFEED-1: teammate findings → durable agent bus envelopes.
 *
 * The comms poll (imessage-inbox-bridge.ts) already receipts allowlisted
 * non-Mason texts into <imessageStateDir>/teammates.jsonl. This bridge mirrors
 * each durable row onto the local agent bus so fleet agents can observe the
 * `teammate.findings` topic, claim a finding by its deterministic envelope id
 * (`ashlr fleet bus-claim acquire --id imessage-teammate-<rowid>`) and act on
 * it under their own authority:
 *
 *   teammateFindingEnvelope(row)    - pure row → envelope mapping; null when a
 *     row can never be enveloped (empty, secret-shaped or oversize text).
 *   teammatePatchEnvelope(receipt)  - pure receipt → announcement envelope for
 *     a verified patch artifact (id `imessage-patch-<transfer id>`).
 *   bridgeTeammateFindings(opts)    - one bounded, serialized pass: posts every
 *     recorded row past the durable watermark and advances it; rows older
 *     than the bus TTL are refused, never reposted under a fresh TTL.
 *
 * RQ-SWE3-IMSGDEEP-1 extension: PATCH-BEGIN/PART/END frames (the dot's chunked
 * patch transfers, imessage-patch-transfer.ts) are protocol traffic — the
 * reassembler consumes them — so each frame row is skipped here (`protocol`),
 * never mirrored as a finding. When a transfer verifies, its receipt is
 * announced instead: one bounded `note` per artifact carrying the transfer id,
 * sha256 prefix and part/byte counts — never the patch body — deduped by the
 * persisted announcedPatchIds ring, and expired receipts are announced-past so
 * no later pass rescans them.
 *
 * Handling is otherwise value-blind: the bridge never reads, classifies or
 * routes on message content beyond the protocol-frame marker. Dedup is by
 * chat.db rowid alone — the envelope id derives from the rowid, so the bus
 * store's exact-envelope dedupe makes every retry safe, and the watermark
 * only records the last handled rowid. Reports carry counts and rowids,
 * never text or handles.
 *
 * Findings are untrusted note bodies, never `kind: 'work'`: nothing here can
 * be claimed by the work loop, select argv, or grant execution authority. The
 * send path, the owner channel receiver and the chief-of-staff queue are
 * untouched. Loopback only: reads one local JSONL file and appends to the
 * local bus store; every entry point never throws.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from '../fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { BUS_V2_TEXT_MAX } from '../agents/bus-v2-schema.js';
import { imessageStateDir } from '../integrations/imessage.js';
import { ensurePrivateDirectory, readPrivateFileCapped } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';
import { readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';
import { isPatchFrameText, readPatchReceipts, type PatchReceipt } from './imessage-patch-transfer.js';

/** Bus address every teammate finding is posted to. */
export const TEAMMATE_FINDINGS_TOPIC = 'teammate.findings';
/** Rows bridged per pass; a deeper backlog drains across later passes. */
export const FINDINGS_BATCH_MAX = 64;
/** Patch announcements per pass; backlog drains across later passes. */
export const PATCH_ANNOUNCE_MAX = 16;
/** Persisted ids of already-handled patch receipts (bounded ring). */
export const ANNOUNCED_MAX = 256;
const WATERMARK_FILE = 'findings-bridge.json';
const LOCK_FILE = 'findings-bridge.lock';
const SENDER_ID = /^imessage:[a-f0-9]{16}$/;
/** Post outcomes that mean this row can never become an envelope; skip past it. */
const TERMINAL = new Set(['conflict', 'invalid']);

export interface FindingsBridgeReport {
  schema: 'imessage.findings-bridge.v1';
  /** busy = another pass holds the lock; pending = candidates remain for the next pass. */
  state: 'healthy' | 'missing' | 'degraded' | 'busy' | 'unavailable' | 'pending';
  /** Candidate rows handled this pass (posted, duplicate or refused). */
  examined: number;
  posted: number;
  duplicate: number;
  /** Rows that can never be enveloped (invalid, secret-shaped, oversize or expired); the watermark advances past them. */
  refused: number;
  /** PATCH-frame rows consumed by the transfer reassembler, never findings; the watermark advances past them. */
  protocol: number;
  /** Verified patch artifacts announced on the findings topic this pass. */
  announced: number;
  /** Unhandled candidates left for the next pass (batch cap or transient store state). */
  pending: number;
  /** Durable watermark after this pass: every rowid at or below it was handled. */
  lastRowid: number;
}

export interface FindingsBridgeOptions {
  /** Shared runs context; default ~/.ashlr-runs. */
  runsDir?: string;
  /** Private bus store root (`appendBusInbox`); default the canonical store. */
  busRoot?: string;
  now?: () => Date;
  signal?: AbortSignal;
  maxBatch?: number;
  /** Trusted test seams; defaults read the real inbox and bus store. */
  readTexts?: typeof readTeammateTexts;
  append?: (envelope: BusEnvelope, options: BusInboxOptions) => BusInboxPost;
  readReceipts?: typeof readPatchReceipts;
}

const empty = (state: FindingsBridgeReport['state'], lastRowid = 0): FindingsBridgeReport =>
  ({ schema: 'imessage.findings-bridge.v1', state, examined: 0, posted: 0, duplicate: 0, refused: 0, protocol: 0, announced: 0, pending: 0, lastRowid });

interface Watermark { lastRowid: number; announcedPatchIds: string[] }

/** Highest handled rowid plus the announced-patch ring, or 0/[] when unwritten. `null` means corrupt, never a silent reset. */
function readWatermark(dir: string): Watermark | null {
  const path = join(dir, WATERMARK_FILE);
  const read = readPrivateFileCapped(path, 64 * 1024);
  // Absent (or a planted non-regular file) starts at 0; an unreadable or
  // oversized file is corrupt — refusing keeps the watermark from resetting.
  if (read === null) {
    try { return statSync(path).isFile() ? null : { lastRowid: 0, announcedPatchIds: [] }; } catch { return { lastRowid: 0, announcedPatchIds: [] }; }
  }
  if (read.truncated) return null;
  try {
    const parsed = JSON.parse(read.text) as { v?: unknown; lastRowid?: unknown; announcedPatchIds?: unknown };
    const lastRowid = parsed.lastRowid;
    const ids = parsed.announcedPatchIds;
    return parsed.v === 1 && Number.isSafeInteger(lastRowid) && (lastRowid as number) >= 0 &&
      (ids === undefined || (Array.isArray(ids) && ids.length <= ANNOUNCED_MAX && ids.every((id) => typeof id === 'string' && id.length <= 128)))
      ? { lastRowid: lastRowid as number, announcedPatchIds: Array.isArray(ids) ? ids as string[] : [] } : null;
  } catch {
    return null;
  }
}

function writeWatermark(dir: string, watermark: Watermark, at: Date): void {
  writePrivateFileAtomically(
    join(dir, `.${randomUUID()}.tmp`), join(dir, WATERMARK_FILE),
    JSON.stringify({ v: 1, lastRowid: watermark.lastRowid, announcedPatchIds: watermark.announcedPatchIds, at: at.toISOString() }),
    { anchorPath: dir, label: 'Findings bridge watermark' },
  );
}

/**
 * One stored teammate row → one deterministic envelope. The id derives only
 * from the rowid: an exact replay dedupes at the store, so no claim or action
 * can ever see the same finding twice. `null` only for rows that can never be
 * enveloped; the caller advances the watermark past them rather than retry.
 */
export function teammateFindingEnvelope(row: Pick<TeammateText, 'rowid' | 'senderId' | 'text'>): BusEnvelope | null {
  if (!Number.isSafeInteger(row.rowid) || row.rowid <= 0 || !SENDER_ID.test(row.senderId) ||
      typeof row.text !== 'string' || row.text.trim().length === 0 ||
      row.text.length > BUS_V2_TEXT_MAX || scrubSecrets(row.text) !== row.text) return null;
  const candidate: BusEnvelope = {
    id: `imessage-teammate-${row.rowid}`,
    from: row.senderId,
    to: TEAMMATE_FINDINGS_TOPIC,
    priority: 'P2',
    ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: 'note',
      text: row.text,
      thread: row.senderId,
      refs: [`imessage:teammate:${row.rowid}`, `queue:${TEAMMATE_FINDINGS_TOPIC}.${row.rowid}`],
    },
    channel: 'imessage',
    channel_ref: `imessage:teammates:${row.rowid}`,
    sender: { agent_id: row.senderId, vendor: 'imessage', human: false, team: true },
    external: false,
  };
  const checked = validateBusEnvelope(candidate);
  return checked.ok ? checked.value : null;
}

/**
 * One verified patch receipt → one deterministic announcement. The body is
 * metadata only — transfer id, sha256 prefix, part and byte counts — never
 * the patch body, which stays on local disk under patches/. `null` for a
 * receipt that can never be announced.
 */
export function teammatePatchEnvelope(receipt: Pick<PatchReceipt, 'id' | 'outcome' | 'senderId' | 'sha256' | 'parts' | 'bytes'>): BusEnvelope | null {
  if (receipt.outcome !== 'verified' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(receipt.id) ||
      !SENDER_ID.test(receipt.senderId) || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '') ||
      !Number.isSafeInteger(receipt.parts) || (receipt.parts as number) < 1 ||
      !Number.isSafeInteger(receipt.bytes) || (receipt.bytes as number) < 0) return null;
  const candidate: BusEnvelope = {
    id: `imessage-patch-${receipt.id}`,
    from: receipt.senderId,
    to: TEAMMATE_FINDINGS_TOPIC,
    priority: 'P2',
    ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: 'note',
      text: `Verified patch artifact imessage/patches/${receipt.id}.patch — sha256 ${receipt.sha256!.slice(0, 16)}, ${receipt.parts} part(s), ${receipt.bytes} byte(s). Artifact only; nothing applies it.`,
      thread: receipt.senderId,
      refs: [`imessage:patch:${receipt.id}`, `queue:${TEAMMATE_FINDINGS_TOPIC}.patch-${receipt.id}`],
    },
    channel: 'imessage',
    channel_ref: `imessage:patches:${receipt.id}`,
    sender: { agent_id: receipt.senderId, vendor: 'imessage', human: false, team: true },
    external: false,
  };
  const checked = validateBusEnvelope(candidate);
  return checked.ok ? checked.value : null;
}

/**
 * One bounded pass over the durable teammate inbox. The watermark advances
 * only across handled rows: a posted/duplicate/refused rowid is durable, while
 * a transient store state stops the pass and the next one retries from the
 * same rowid. Never throws; never touches the intake cursor or a reply path.
 *
 * The inbox read is deliberately unbounded — no `sinceMs` is passed to
 * readTeammateTexts. `sinceMs` is an age duration (a row is dropped when
 * `now - at > sinceMs`), and the pass must still SEE rows older than the bus
 * TTL: an expired row can never be posted — the store stamps a fresh
 * CHANNEL_BUS_TTL_MS at append time, so bridging it would revive an expired
 * finding — but it is terminal like a refusal, counted `refused` and advanced
 * past so no later pass rescans it.
 */
export function bridgeTeammateFindings(options: FindingsBridgeOptions = {}): FindingsBridgeReport {
  const dir = imessageStateDir(options.runsDir);
  const now = options.now ?? (() => new Date());
  let held: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    ensurePrivateDirectory(dir);
    held = acquireLocalStoreLockWithOutcome(join(dir, LOCK_FILE), 0, { anchorPath: dir });
    if (held.state !== 'acquired') return empty(held.state === 'contended' ? 'busy' : 'unavailable');
    const watermark = readWatermark(dir);
    if (watermark === null) return empty('unavailable');
    const inbox = (options.readTexts ?? readTeammateTexts)({
      runsDir: options.runsDir, includeAnswered: true, now: () => now().getTime(),
    });
    const announced = new Set(watermark.announcedPatchIds);
    let announcedDirty = false;
    const report = empty(inbox.sourceState === 'missing' ? 'missing' : inbox.sourceState === 'degraded' ? 'degraded' : 'healthy', watermark.lastRowid);
    const candidates = inbox.texts.filter((row) => row.rowid > watermark.lastRowid).sort((a, b) => a.rowid - b.rowid);
    const limit = options.maxBatch ?? FINDINGS_BATCH_MAX;
    const append = options.append ?? appendBusInbox;
    const nowMs = now().getTime();
    const post = (envelope: BusEnvelope): BusInboxPost => {
      try {
        return append(envelope, { root: options.busRoot, now: () => nowMs });
      } catch {
        return { status: 'unavailable' };
      }
    };
    let handled = watermark.lastRowid;
    let pending = candidates.length;
    if (inbox.sourceState !== 'missing') {
      let index = 0;
      for (; index < candidates.length; index++) {
        const row = candidates[index]!;
        if (index >= limit || options.signal?.aborted) break;
        // PATCH-BEGIN/PART/END frames are transfer protocol, never findings: the
        // reassembler consumed them at intake and the watermark passes them here.
        if (isPatchFrameText(row.text)) { report.protocol++; handled = row.rowid; continue; }
        // Expired findings never post: an append would stamp a fresh 7-day TTL
        // and revive them. Terminal like a refusal — the watermark passes them.
        if (nowMs - Date.parse(row.at) > CHANNEL_BUS_TTL_MS) { report.refused++; handled = row.rowid; continue; }
        const envelope = teammateFindingEnvelope(row);
        if (envelope === null) { report.refused++; handled = row.rowid; continue; }
        const outcome = post(envelope);
        if (outcome.status === 'posted') report.posted++;
        else if (outcome.status === 'duplicate') report.duplicate++;
        else if (TERMINAL.has(outcome.status)) { report.refused++; handled = row.rowid; continue; }
        else break;
        handled = row.rowid;
      }
      report.examined = index;
      pending = candidates.length - index;
    }

    // Verified patch artifacts are announced on the same topic: one note per
    // receipt, deduped by the announced ring and the deterministic envelope id.
    // Rejected, expired or stale receipts are announced-past forever.
    if (!options.signal?.aborted) {
      const receipts = (options.readReceipts ?? readPatchReceipts)({ runsDir: options.runsDir });
      let announcedThisPass = 0;
      for (const receipt of receipts.receipts) {
        if (announced.has(receipt.id)) continue;
        if (announcedThisPass >= PATCH_ANNOUNCE_MAX) { pending++; continue; }
        announcedThisPass++;
        if (receipt.outcome !== 'verified' || nowMs - Date.parse(receipt.completedAt) > CHANNEL_BUS_TTL_MS) {
          announced.add(receipt.id);
          announcedDirty = true;
          continue;
        }
        const envelope = teammatePatchEnvelope(receipt);
        if (envelope === null) { announced.add(receipt.id); announcedDirty = true; continue; }
        const outcome = post(envelope);
        if (outcome.status === 'posted') { report.announced++; announced.add(receipt.id); announcedDirty = true; }
        else if (outcome.status === 'duplicate' || TERMINAL.has(outcome.status)) { announced.add(receipt.id); announcedDirty = true; }
        else { pending++; announcedThisPass--; break; }
      }
    }
    report.pending = pending;
    report.lastRowid = handled;
    if (handled > watermark.lastRowid || announcedDirty) {
      writeWatermark(dir, { lastRowid: handled, announcedPatchIds: [...announced].slice(-ANNOUNCED_MAX) }, now());
    }
    if (report.state === 'healthy' && report.pending > 0) report.state = 'pending';
    return report;
  } catch {
    return empty('unavailable');
  } finally {
    if (held?.state === 'acquired') releaseLocalStoreLock(held.lock);
  }
}
