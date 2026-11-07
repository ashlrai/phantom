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
 *   bridgeTeammateFindings(opts)    - one bounded, serialized pass: posts every
 *     recorded row past the durable watermark and advances it.
 *
 * Handling is value-blind: the bridge never reads, classifies or routes on
 * message content. Dedup is by chat.db rowid alone — the envelope id derives
 * from the rowid, so the bus store's exact-envelope dedupe makes every retry
 * safe, and the watermark only records the last handled rowid. Reports carry
 * counts and rowids, never text or handles.
 *
 * Findings are untrusted note bodies, never `kind: 'work'`: nothing here can
 * be claimed by the work loop, select argv, or grant execution authority. The
 * send path, the owner channel receiver and the chief-of-staff queue are
 * untouched. Loopback only: reads one local JSONL file and appends to the
 * local bus store; every entry point never throws.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from '../fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { BUS_V2_TEXT_MAX } from '../agents/bus-v2-schema.js';
import { imessageStateDir } from '../integrations/imessage.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';
import { readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';

/** Bus address every teammate finding is posted to. */
export const TEAMMATE_FINDINGS_TOPIC = 'teammate.findings';
/** Rows bridged per pass; a deeper backlog drains across later passes. */
export const FINDINGS_BATCH_MAX = 64;
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
  /** Rows that can never be enveloped; the watermark advances past them. */
  refused: number;
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
}

const empty = (state: FindingsBridgeReport['state'], lastRowid = 0): FindingsBridgeReport =>
  ({ schema: 'imessage.findings-bridge.v1', state, examined: 0, posted: 0, duplicate: 0, refused: 0, pending: 0, lastRowid });

/** Highest rowid ever handed to the store, or 0 when unwritten. `null` means corrupt, never a silent reset. */
function readWatermark(dir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, WATERMARK_FILE), 'utf8')) as { v?: unknown; lastRowid?: unknown };
    const lastRowid = parsed.lastRowid;
    return parsed.v === 1 && Number.isSafeInteger(lastRowid) && (lastRowid as number) >= 0 ? lastRowid as number : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null;
  }
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
 * One bounded pass over the durable teammate inbox. The watermark advances
 * only across handled rows: a posted/duplicate/refused rowid is durable, while
 * a transient store state stops the pass and the next one retries from the
 * same rowid. Never throws; never touches the intake cursor or a reply path.
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
    if (inbox.sourceState === 'missing') return empty('missing', watermark);
    const report = empty(inbox.sourceState === 'degraded' ? 'degraded' : 'healthy', watermark);
    const candidates = inbox.texts.filter((row) => row.rowid > watermark).sort((a, b) => a.rowid - b.rowid);
    const limit = options.maxBatch ?? FINDINGS_BATCH_MAX;
    const append = options.append ?? appendBusInbox;
    let handled = watermark;
    let index = 0;
    for (; index < candidates.length; index++) {
      const row = candidates[index]!;
      if (index >= limit || options.signal?.aborted) break;
      const envelope = teammateFindingEnvelope(row);
      if (envelope === null) { report.refused++; handled = row.rowid; continue; }
      let post: BusInboxPost;
      try {
        post = append(envelope, { root: options.busRoot, now: () => now().getTime() });
      } catch {
        post = { status: 'unavailable' };
      }
      if (post.status === 'posted') report.posted++;
      else if (post.status === 'duplicate') report.duplicate++;
      else if (TERMINAL.has(post.status)) { report.refused++; handled = row.rowid; continue; }
      else break;
      handled = row.rowid;
    }
    report.examined = index;
    report.pending = candidates.length - index;
    report.lastRowid = handled;
    if (handled > watermark) {
      writePrivateFileAtomically(
        join(dir, `.${randomUUID()}.tmp`), join(dir, WATERMARK_FILE),
        JSON.stringify({ v: 1, lastRowid: handled, at: now().toISOString() }),
        { anchorPath: dir, label: 'Findings bridge watermark' },
      );
    }
    if (report.state === 'healthy' && report.pending > 0) report.state = 'pending';
    return report;
  } catch {
    return empty('unavailable');
  } finally {
    if (held?.state === 'acquired') releaseLocalStoreLock(held.lock);
  }
}
