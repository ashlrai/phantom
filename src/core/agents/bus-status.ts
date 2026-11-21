/** One read-only health probe over every store the unified `agents bus` verbs
 * touch: the message inbox, the identity registry, the wake queue, the shared
 * coordination table, the message-id claim journal, the v2 work feed, the
 * owner-chat share receipts ledger `inbox` consults for `agent-chat-owner`
 * envelopes and the legacy `phm bus` mailbox `work mine` still reads. Each
 * section reports its own real state; a section that cannot be read reports
 * unavailable or null, never zero, and the whole read never throws. Read-only:
 * takes no writer lock, writes nothing, makes no network calls and grants
 * nothing. */
import { dirname, join } from 'node:path';
import { inspectBusInbox, busPathMissing, type BusInboxInspection } from '../fleet/bus-inbox.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { createBusMailbox } from '../fleet/bus-mailbox.js';
import { coordinationSummary } from './claim-store.js';
import { readBusWakes } from '../fleet/bus-wake-queue.js';
import { readAgentRegistry } from './bus-identity.js';
import { readBusWorkFeed, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { ownerChatRoot, ownerReceiptDir, readOwnerChatReceipts } from './chat-owner-receipts.js';

export interface UnifiedBusStatusOptions {
  /** Same root as BusInboxOptions.root; default `$ASHLR_HOME/fleet`. */
  root?: string;
  /** Parent of `bus/wake-queue.jsonl`; default ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsRoot?: string;
  now?: () => number;
}

export interface UnifiedBusStatus {
  /** ISO time the probe ran; each section is one internally consistent read. */
  asOf: string;
  /** Message store behind dm, channel, handoff, inbox and work post/status. */
  store: BusInboxInspection;
  /** Identity registry behind handle, alias, channel membership and seat labels. */
  registry: {
    source: 'missing' | 'available' | 'unavailable';
    /** Registered identities; null when the registry cannot be read. A missing
     * registry verifiably holds none, so its counts are 0, not null. */
    identities: number | null;
    channels: number | null;
  };
  /** Wake hint queue behind `wake`, `wakes` and priority fan-out. */
  wakes: {
    state: 'missing' | 'unreadable' | 'ok';
    /** Hints observed in the bounded queue tail, before the read's row cap; null unless the queue was read. */
    hints: number | null;
    /** Older bytes or hints sit beyond the bounded tail or row cap; null when the queue state is unknown. */
    truncated: boolean | null;
  };
  /** Shared coordination table behind `claim` and feed `--claims` joins. */
  coordination: {
    source: 'missing' | 'available' | 'unavailable';
    liveClaims: number | null;
    statuses: number | null;
  };
  /** Message-id claim journal (`bus-work-claims`) behind `fleet bus-next` and
   * `bus-claim` message claims, the `work mine` next-section hold state and
   * the comms inbox bus section. Its rows gate message work the same way the
   * coordination table gates feed jobs, so an unreadable journal degrades
   * those reads while leaving this probe's other sections intact. */
  workClaims: {
    source: 'missing' | 'available' | 'unavailable';
    /** Claim records retained in the journal; null unless it was read, the
     * same convention the coordination section uses for an unprobed store. */
    claims: number | null;
  };
  /** v2 work-feed projection behind `work post|status|feed`. */
  feed: {
    status: BusWorkFeedReadResult['status'];
    /** Jobs in the projection; null unless the feed read is ok. A refused feed
     * is a real projection failure (duplicate job, missing provider), never an
     * empty feed. */
    jobs: number | null;
    /** Refusal reason when status is refused; absent otherwise. */
    reason?: string;
    /** Wire id of the retained receipt the refused projection blamed;
     * absent when the refusal names none or the feed is not refused. */
    receipt?: string;
  };
  /** Legacy `phm bus` mailbox store (`$ASHLR_HOME/bus-mailbox`) behind the
   * `work mine` mailbox section and `phm bus inbox|ack`. */
  mailbox: {
    source: 'missing' | 'available' | 'unavailable';
    /** Pending (unacked, unexpired) messages across every recipient label —
     * a store-wide total, never per-label detail; 0 on a verified-missing
     * store, null when the store cannot be read. */
    pending: number | null;
  };
  /** Owner-chat share receipts ledger (`$ASHLR_HOME/fleet/owner-chat-receipts`)
   * behind the `inbox`/`work mine` filter on `agent-chat-owner` envelopes: an
   * unreadable ledger makes those reads report unavailable, so the probe
   * names the dependency directly. */
  ownerChat: {
    source: 'missing' | 'available' | 'unavailable';
    /** Retained receipt rows; 0 on a verified-missing ledger, null when it
     * cannot be read. */
    receipts: number | null;
  };
}

/** Compose the dependency reads. Each probe is isolated: one failing
 * store degrades only its own section. */
export function readUnifiedBusStatus(options: UnifiedBusStatusOptions = {}): UnifiedBusStatus {
  const now = options.now ?? Date.now;
  const asOf = new Date(now()).toISOString();

  const store = inspectBusInbox({ root: options.root, now });

  let registry: UnifiedBusStatus['registry'];
  try {
    const read = readAgentRegistry({ root: options.root, now });
    registry = read.status === 'ok'
      ? { source: read.source, identities: read.registry.identities.length, channels: read.registry.channels.length }
      : { source: 'unavailable', identities: null, channels: null };
  } catch {
    registry = { source: 'unavailable', identities: null, channels: null };
  }

  let wakes: UnifiedBusStatus['wakes'];
  try {
    const read = readBusWakes({ root: options.runsRoot });
    wakes = { state: read.state, hints: read.matched, truncated: read.truncated };
  } catch {
    wakes = { state: 'unreadable', hints: null, truncated: null };
  }

  let coordination: UnifiedBusStatus['coordination'];
  try {
    coordination = coordinationSummary(options.root, now());
  } catch {
    coordination = { source: 'unavailable', liveClaims: null, statuses: null };
  }

  let workClaims: UnifiedBusStatus['workClaims'];
  try {
    const read = inspectBusWorkClaims(options.root);
    workClaims = { source: read.source, claims: read.source === 'available' ? read.claims.length : null };
  } catch {
    workClaims = { source: 'unavailable', claims: null };
  }

  let feed: UnifiedBusStatus['feed'];
  try {
    const read = readBusWorkFeed({ root: options.root, now });
    feed = read.status === 'ok'
      ? { status: 'ok', jobs: read.jobs.length }
      : read.status === 'refused'
        ? { status: 'refused', jobs: null, reason: read.reason,
            ...(read.receipt === undefined ? {} : { receipt: read.receipt.id }) }
        : { status: read.status, jobs: null };
  } catch {
    feed = { status: 'unavailable', jobs: null };
  }

  // The mailbox home is the fleet root's parent — the same derivation
  // `work mine` applies — so a custom root probes the matching scratch store.
  let mailbox: UnifiedBusStatus['mailbox'];
  try {
    mailbox = createBusMailbox(options.root === undefined ? undefined : dirname(options.root), now).inspect();
  } catch {
    mailbox = { source: 'unavailable', pending: null };
  }

  // Same root derivation `readAgentInbox` applies to the share receipts
  // ledger. readOwnerChatReceipts verifies either path absent as an empty
  // ledger, so existence is probed first: a never-written store reports
  // missing rather than available-with-zero.
  let ownerChat: UnifiedBusStatus['ownerChat'];
  try {
    const chatRoot = ownerChatRoot(options.root);
    const dir = ownerReceiptDir(chatRoot);
    ownerChat = busPathMissing(dir) || busPathMissing(join(dir, 'receipts.json'))
      ? { source: 'missing', receipts: 0 }
      : { source: 'available', receipts: readOwnerChatReceipts(chatRoot).length };
  } catch {
    ownerChat = { source: 'unavailable', receipts: null };
  }

  return { asOf, store, registry, wakes, coordination, workClaims, feed, mailbox, ownerChat };
}
