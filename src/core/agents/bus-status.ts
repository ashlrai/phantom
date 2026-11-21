/** One read-only health probe over every store the unified `agents bus` verbs
 * touch: the message inbox, the identity registry, the wake queue, the shared
 * coordination table, the message-id claim journal and the v2 work feed. Each
 * section reports its own real state; a section that cannot be read reports
 * unavailable or null, never zero, and the whole read never throws. Read-only:
 * takes no writer lock, writes nothing, makes no network calls and grants
 * nothing. */
import { inspectBusInbox, type BusInboxInspection } from '../fleet/bus-inbox.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { coordinationSummary } from './claim-store.js';
import { readBusWakes } from '../fleet/bus-wake-queue.js';
import { readAgentRegistry } from './bus-identity.js';
import { readBusWorkFeed, type BusWorkFeedReadResult } from './bus-work-feed-read.js';

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
    /** Hints observed in the bounded queue tail; null unless state is ok. */
    hints: number | null;
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
}

/** Compose the six dependency reads. Each probe is isolated: one failing
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
    wakes = { state: read.state, hints: read.state === 'ok' ? read.wakes.length : null };
  } catch {
    wakes = { state: 'unreadable', hints: null };
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

  return { asOf, store, registry, wakes, coordination, workClaims, feed };
}
