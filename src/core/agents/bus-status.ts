/** One read-only health probe over every store the unified `agents bus` verbs
 * touch: the message inbox, the identity registry, the wake queue, the shared
 * coordination table, the message-id claim journal, the v2 work feed, the
 * bus hop log every wake-enabled send appends, the
 * shared task board and fleet queue `work mine`'s board section reads, the
 * owner-chat share receipts ledger `inbox` consults for `agent-chat-owner`
 * envelopes, the legacy `phm bus` mailbox `work mine` still reads, the
 * bot-seat store `work mine`'s seats section, `id list`'s seat participants,
 * the unified inbox seats source read and the seat apply path's notice
 * receipts, the agentnet peer work-dispatch
 * journal `consumePeerWork` and the unified inbox peer-dispatch source read,
 * the agentnet peer coordination ledger `sendPeerMessage`, `readPeerInbox`,
 * `peers dispatch` and `phm fleet peer-ledger` parse, the agentnet peer
 * session bindings `peers send|post|read|list|dispatch` authenticate
 * against and the host-provisioned dispatch policy `consumePeerWork`
 * requires, the session-handoff
 * journal store `phm checkpoint handoff list|show` and
 * `fleet_session_handoffs` read, the claim-store
 * drift verdict comparing the claim journal with the coordination table it
 * is dual-written to, and the outbound send gate `localWriteGate` applies
 * before every bus write lands. Each
 * section reports its own real state; a section that cannot be read reports
 * unavailable or null, never zero, and the whole read never throws. Read-only:
 * takes no writer lock, writes nothing, makes no network calls and grants
 * nothing. */
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { inspectBusInbox, busPathMissing, type BusInboxInspection } from '../fleet/bus-inbox.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { readClaimStoreDrift } from '../fleet/claim-store-drift.js';
import { createBusMailbox } from '../fleet/bus-mailbox.js';
import { BusBoard, busBoardStoragePaths, type BusBoardStateSummary } from '../fleet/bus-board.js';
import { SharedStore } from '../fleet/shared-store.js';
import { ashlrHome } from '../cloud/store.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import type { AshlrConfig } from '../types.js';
import { listCoordination } from './claim-store.js';
import { readBusWakes } from '../fleet/bus-wake-queue.js';
import { BUS_HOPLOG_TAIL_MAX_ROWS, readBusHoplogTail } from '../fleet/bus-hoplog.js';
import { readAgentRegistry } from './bus-identity.js';
import { inspectSeatStore } from '../bots/seats.js';
import { readBusWorkFeed, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { ownerChatRoot, ownerReceiptDir, readOwnerChatReceipts } from './chat-owner-receipts.js';
import { readWorkDispatchJournal } from '../agentnet/work-dispatch-journal.js';
import { inspectPeerDispatchPolicy } from '../agentnet/work-dispatch.js';
import { readPeerLedger } from '../agentnet/peer-ledger.js';
import { inspectPeerBindings } from '../agentnet/slack-identities.js';
import { listSessionHandoffs } from './session-handoff.js';
import { handoffPressure } from './session-handoff-schema.js';
import { probePauseState } from '../comms/pause.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { realHome } from '../real-home.js';
import type { BusWorkMineBoardOptions } from './bus-work-mine.js';

export interface UnifiedBusStatusOptions {
  /** Same root as BusInboxOptions.root; default `$ASHLR_HOME/fleet`. */
  root?: string;
  /** Parent of `bus/wake-queue.jsonl`; default ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsRoot?: string;
  /** Shared task board and fleet queue overrides; production derives the same
   * paths `phm bus board` and `work mine` use. */
  board?: BusWorkMineBoardOptions;
  /** Seat store home override — the same `SeatOptions.home` `work mine`'s
   * seats section resolves; default the process home. Only the file probe
   * runs here: quota evidence, live claims and node jobs stay with the
   * async `planSeatHandoffs` read. */
  seats?: { home?: string };
  /** Peer bindings path override — the same `PeerBusOptions.bindings`
   * `peers list` and every authenticated peer verb resolves; default
   * `agentnetPaths().bindings` under `realHome()`. A `root` override does
   * NOT relocate it: the peer verbs keep reading the host-enrolled
   * bindings regardless of which bus root their journals land under, so
   * the probe follows the same resolution rather than inventing a
   * bus-root-relative path no verb touches. */
  agentnetBindings?: string;
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
  /** Bus hop log (`<root>/bus/hops.jsonl`, or `busHoplogPath()` when no
   * root override is set) behind `fleet_bus_hops`, the fleet live-bus
   * feed's hop pane and the wake-hop recording every `dm`, `post`,
   * `channel post`, `handoff`, `wake` and channel-mirror send appends —
   * read by `readBusHoplogTail`, the same bounded tail
   * `readFleetBusHops` serves under the same path the send path's
   * `hoplogFile` resolves, so a corrupt, permissive or otherwise
   * unreadable log is named here instead of leaving status green while
   * hop reads report unreadable and sends record `hoplog: 'failed'`.
   * Counts only, never message ids, agent labels or bodies. */
  hoplog: {
    state: 'missing' | 'unreadable' | 'ok';
    /** On-disk byte size when the log passed custody checks; 0 on a
     * verified-missing log (an absent file holds no bytes), null when
     * it cannot be read. */
    bytes: number | null;
    /** Valid hops inside the bounded tail window — a floor the
     * `truncated` flag qualifies, never a fleet-wide total; 0 on a
     * verified-missing log, null when unreadable. */
    hops: number | null;
    /** Malformed, torn or unvalidated rows inside the read window —
     * degraded evidence, never recorded activity; same null rule. */
    skippedRows: number | null;
    /** Older bytes or further hops sit beyond the bounded read; null
     * when the log state is unknown. */
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
  /** Cross-store consistency verdict between the message-id claim journal
   * (`workClaims`) and the coordination table (`coordination`) — the two
   * stores `mutateBusWorkClaim` dual-writes, compared by the same
   * `fleet.claim-drift.v1` read `ashlr fleet claim-drift` serves, run over
   * the probe's own two reads so the verdict describes the same snapshots
   * the adjacent sections report. VERIFIED: every live bus claim has its
   * coordination partner under the same owner. DRIFT: live claims the two
   * stores disagree about — the counts name bus-only, coordination-only and
   * owner-mismatch rows. UNKNOWN: a side could not be read, so every count
   * is null — never zero. */
  claimDrift: {
    state: 'VERIFIED' | 'DRIFT' | 'UNKNOWN';
    /** Joined live pairs whose owners agree; null when the comparison could not run. */
    matched: number | null;
    /** Live bus claims with no coordination partner; same null rule. */
    busOnly: number | null;
    /** Live message-origin coordination claims with no bus partner; same null rule. */
    coordOnly: number | null;
    /** Joined pairs whose owners disagree; same null rule. */
    ownerMismatch: number | null;
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
  /** Shared task board (`<dirname(fleetRoot)>/bus/state.json`, or the
   * configured shared queue's `path/bus`) plus the fleet queue claim index
   * (`<fleetRoot>/bus-queue`, or the shared queue `path`) behind `work mine`'s
   * board section, the `phm bus board` verbs and the unified inbox board
   * source — the one pending-work store the status probe used to leave
   * unprobed, so a sick board reported all-green. */
  board: {
    source: 'missing' | 'available' | 'unavailable';
    /** Stored board threads; 0 on a verified-missing board, null when the
     * state cannot be read. */
    threads: number | null;
    /** Stored board tasks; same convention. */
    tasks: number | null;
    /** Deliveries no receipt acknowledges — board mail still awaiting
     * receipt; same convention. */
    pendingDeliveries: number | null;
    /** Fleet queue claim-index readability: 'unreadable' degrades every board
     * task hold and the queue-backed claim evidence to unknown in `work mine`
     * and the inbox; null when the queue was not probed (invalid shared-queue
     * config or non-absolute override). */
    claims: 'readable' | 'unreadable' | null;
  };
  /** Bot-seat store (`<home>/.phantom/bots`) behind `work mine`'s seats
   * section, `id list`'s seat participants, the unified inbox seats
   * source and the `bots handoff(s) --apply` notice receipts — probed by
   * `inspectSeatStore`, the file half of the same `snapshot()`
   * `planSeatHandoffs` reads plus the `handoff-notices.json` receipts map
   * `applySeatHandoff` indexes and rewrites, so a sick roster, journal or
   * receipts file is named here instead of leaving status green while
   * those reads report unavailable. `source` plus retained counts:
   * `seats` roster rows, `states` seat-state entries, `handoffs`
   * journaled records, `notices` receipt-map entries — 0 on a
   * verified-missing store, null for a file that cannot be read or
   * validated, never a plan verdict, seat contents or quota evidence. */
  seats: {
    source: 'missing' | 'available' | 'unavailable';
    seats: number | null;
    states: number | null;
    handoffs: number | null;
    notices: number | null;
  };
  /** Agentnet peer work-dispatch journal (`<busRoot>/agentnet/work-dispatch.json`)
   * behind `phm agentnet peers dispatch` and the unified inbox peer-dispatch
   * source — read by `readWorkDispatchJournal`, the same reader
   * `consumePeerWork` uses, under the same root it resolves
   * (`agentnetPaths().busRoot` = `realHome()/.ashlr/fleet`, or the probe's
   * `root` override), so a corrupt journal is named here instead of leaving
   * status green while dispatch refuses and the inbox reports unavailable.
   * Counts only, never peer names, claim keys or bodies. */
  peerDispatch: {
    source: 'missing' | 'available' | 'unavailable';
    /** Retained dispatch receipts; 0 on a verified-missing journal, null when unreadable. */
    receipts: number | null;
    /** Receipts whose recorded `sent` outcome differs from `outcome` — the
     * unpublished backlog `consumePeerWork` would publish and the unified
     * inbox peer-dispatch source lists; same null rule as `receipts`. */
    unpublished: number | null;
  };
  /** Agentnet peer coordination ledger
   * (`<busRoot>/agentnet/coordination.json`) behind `phm agentnet peers
   * send|post|read|dispatch` admission, dedupe and rate limits, `phm fleet
   * peer-ledger`/`fleet_peer_ledger` and the peer-bus budget gate — read by
   * `readPeerLedger`, the same reader those surfaces use, under the same
   * root `agentnetPaths().busRoot` resolves (`realHome()/.ashlr/fleet`, or
   * the probe's `root` override), so a corrupt, public-mode or otherwise
   * unreadable ledger is named here instead of leaving status green while
   * every peer verb refuses closed. Counts only, never peer names, claim
   * keys, digests, threads or bodies. */
  peerLedger: {
    source: 'missing' | 'available' | 'unavailable';
    /** Live (unexpired) coordination rows the peer send budget still
     * counts; 0 on a verified-missing ledger, null when it cannot be read. */
    liveRows: number | null;
  };
  /** Agentnet peer session bindings (`agentnetPaths().bindings` —
   * `<realHome>/.ashlr/agentnet/bindings.json` — or the probe's
   * `agentnetBindings` override) behind `phm agentnet peers
   * send|post|read|list|dispatch` and `consumePeerWork`'s consumer
   * authentication — read by `inspectPeerBindings`, the count-only
   * counterpart of the `readPeerBindings` validation every peer verb
   * runs. Like `sendGate`, the path resolves under `realHome()` and is
   * never relocated by the probe's `root` override: the peer verbs keep
   * authenticating against the host-enrolled file whatever bus root
   * their journals use, so a corrupt, public-mode or conflicting
   * bindings file is named here instead of leaving status green while
   * every peer verb refuses closed. Counts only, never callsigns, lanes,
   * session ids, hashes or team/user/bot ids. */
  peerBindings: {
    source: 'missing' | 'available' | 'unavailable';
    /** Binding rows retained; 0 on a verified-missing file, null when it
     * cannot be read or validated. */
    peers: number | null;
    /** Rows whose `expiresAt` is still ahead of the probe's clock —
     * sessions that can authenticate now; same null rule. */
    active: number | null;
  };
  /** Agentnet peer dispatch policy (`dispatch.json` beside the resolved
   * bindings path — the sibling-of-bindings path `consumePeerWork`
   * resolves) behind `phm agentnet peers dispatch --apply` — read by
   * `inspectPeerDispatchPolicy`, validated by the same `policySchema`
   * the consumer enforces, so a missing or invalid policy is named here
   * instead of leaving status green while dispatch refuses
   * 'dispatch-unavailable-or-gated'. Counts only, never peer callsigns,
   * repository names, tier ceilings or path grants. */
  peerDispatchPolicy: {
    source: 'missing' | 'available' | 'unavailable';
    /** Peer callsigns the policy allows; 0 on a verified-missing file,
     * null when it cannot be read or validated. Counts only. */
    peers: number | null;
    /** Repository capability rows the policy carries; same null rule. */
    repositories: number | null;
  };
  /** Session-handoff journal store (`<runsRoot>/handoffs/*.jsonl`) behind
   * `phm checkpoint handoff list|show` and `fleet_session_handoffs` — read
   * by `listSessionHandoffs`,
   * the same bounded fleet-wide scan those surfaces serve under the same
   * runs root `options.runsRoot` selects (default `ASHLR_RUNS_DIR` or
   * `~/.ashlr-runs`), so a corrupt journal, unreadable directory or unsafe
   * store is named here instead of leaving status green while those reads
   * report unavailable. Counts only, never job ids, lanes, models or
   * signal payloads. */
  sessionHandoffs: {
    source: 'missing' | 'available' | 'unavailable';
    /** Journal files the bounded scan covered; 0 on a verified-missing
     * store, null when the directory cannot be read. */
    journals: number | null;
    /** Journals whose latest signal is not 'completed' — parked or
     * in-flight checkpoints; same null rule. */
    open: number | null;
    /** Open journals whose latest signal requests failover — rate-limit,
     * quota-exhausted or budget at/under its threshold, the
     * `handoffPressure` rule `planSessionFailover` enforces; same null
     * rule. */
    awaitingFailover: number | null;
    /** Journals that failed the same validation `handoff show` applies;
     * same null rule. */
    unreadable: number | null;
    /** More journal files exist than the bounded scan covers; null when
     * the store state is unknown. */
    truncated: boolean | null;
  };
  /** Outbound send gate behind every bus write verb — the kill-switch
   * sentinel and the comms soft-pause flag `localWriteGate` consults
   * before `dm`, `post`, `channel post`, `handoff`, `wake` and the work
   * verbs append, under `realHome()` (the same paths the send path
   * resolves, never the probe's `root` override). `state` is the verdict
   * an agent can check before sending: 'open' neither gate blocks,
   * 'blocked' at least one gate provably refuses (kill active or pause
   * set), 'unknown' no gate provably blocks but at least one source
   * could not be inspected — the send path still fails closed on both,
   * so unknown is never open. Each gate keeps its own inspection verdict
   * rather than collapsing into the other's: an uninspectable KILL
   * sentinel is not a pause, and an unreadable pause.json is not an
   * armed kill switch. */
  sendGate: {
    state: 'open' | 'blocked' | 'unknown';
    /** Kill-switch sentinel (`readKillSwitch`, the same read
     * `killSwitchOn` projects onto its boolean): 'active' the sentinel is
     * present, 'inactive' proven absent, 'unknown' uninspectable or
     * unsafe — the send gate treats anything but 'inactive' as on.
     * `reason` is the read's own verdict ('present', 'missing',
     * 'uninspectable', 'unsafe'). */
    kill: { state: 'active' | 'inactive' | 'unknown'; reason: string };
    /** Comms soft-pause flag (`probePauseState`, the same inspection
     * `isPaused` fails closed on): 'paused' a valid flag is set,
     * 'clear' the file was inspected and holds no pause, 'unknown' the
     * file could not be inspected — the send gate treats it as paused.
     * `since` is the recorded pause start (epoch ms) when the flag
     * carried one; `reason` is the fail-closed cause when unknown —
     * fixed phrases only, never a path or file contents. */
    pause: { state: 'paused' | 'clear' | 'unknown'; since: number | null; reason: string | null };
  };
}

/** The board probe: shared task board state plus the fleet queue claim index
 * behind its task holds — the same stores `work mine`'s board section and
 * `phm bus board` read, derived by the same `busBoardStoragePaths` helper.
 * A never-written board is a verified-missing source with real zeros; an
 * unreadable board, malformed config or untrusted shared-queue path reports
 * unavailable with null counts. The queue's own readability is probed
 * independently and reported whenever the paths derive, so a corrupt board
 * state never hides a sick queue — or vice versa. */
function probeBusBoard(options: UnifiedBusStatusOptions): UnifiedBusStatus['board'] {
  const unavailable = (claims: 'readable' | 'unreadable' | null) =>
    ({ source: 'unavailable' as const, threads: null, tasks: null,
      pendingDeliveries: null, claims });
  const overrides = options.board;
  if ((overrides?.root !== undefined && !isAbsolute(overrides.root)) ||
      (overrides?.queueRoot !== undefined && !isAbsolute(overrides.queueRoot))) {
    return unavailable(null);
  }
  let cfg: AshlrConfig;
  try {
    cfg = overrides?.config ?? loadConfigReadOnlyStrict();
  } catch {
    return unavailable(null);
  }
  const paths = busBoardStoragePaths(options.root ?? join(ashlrHome(), 'fleet'), cfg);
  if (paths.status !== 'ok') return unavailable(null);
  const shared = cfg.fleet?.sharedQueue;
  const fleet = new SharedStore(overrides?.queueRoot ?? paths.queueRoot,
    overrides?.leaseMs ?? shared?.leaseMs);
  const claims = fleet.readClaimIndex().readable ? 'readable' as const : 'unreadable' as const;
  let summary: BusBoardStateSummary | null;
  try {
    summary = new BusBoard({ root: overrides?.root ?? paths.boardRoot, fleet, cfg }).inspect();
  } catch {
    return unavailable(claims);
  }
  if (summary === null) {
    return { source: 'missing', threads: 0, tasks: 0, pendingDeliveries: 0, claims };
  }
  return { source: 'available', threads: summary.threads, tasks: summary.tasks,
    pendingDeliveries: summary.pendingDeliveries, claims };
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

  // The hop log is the send path's own observability tail: every wake a
  // bus send requests appends one validated row under
  // `<root>/bus/hops.jsonl` — the same path `hoplogFile()` resolves for
  // writes (or `busHoplogPath()` with no root, probed with its full
  // ancestor custody chain). `readBusHoplogTail` is the same bounded
  // read `readFleetBusHops` serves, so a sick log is named here instead
  // of leaving status green while `fleet_bus_hops` reports unreadable
  // and sends keep recording `hoplog: 'failed'`. Counts only, never
  // ids, labels or bodies; a verified-missing log reports real zeros,
  // the same convention the wake queue applies.
  let hoplog: UnifiedBusStatus['hoplog'];
  try {
    const tail = readBusHoplogTail(BUS_HOPLOG_TAIL_MAX_ROWS,
      options.root === undefined ? undefined : join(options.root, 'bus', 'hops.jsonl'));
    hoplog = tail.state === 'ok'
      ? { state: 'ok', bytes: tail.logBytes, hops: tail.hops?.length ?? null,
          skippedRows: tail.skippedRows, truncated: tail.truncated }
      : tail.state === 'missing'
        ? { state: 'missing', bytes: 0, hops: 0, skippedRows: 0, truncated: false }
        : { state: 'unreadable', bytes: null, hops: null, skippedRows: null, truncated: null };
  } catch {
    hoplog = { state: 'unreadable', bytes: null, hops: null, skippedRows: null, truncated: null };
  }

  let coordinationRead: ReturnType<typeof listCoordination> | undefined;
  let coordination: UnifiedBusStatus['coordination'];
  try {
    coordinationRead = listCoordination(options.root, now());
    coordination = coordinationRead.source === 'available'
      ? { source: 'available',
          liveClaims: coordinationRead.claims.filter(row => row.live).length,
          statuses: coordinationRead.statuses.length }
      : { source: coordinationRead.source, liveClaims: null, statuses: null };
  } catch {
    coordination = { source: 'unavailable', liveClaims: null, statuses: null };
  }

  let busClaimsRead: ReturnType<typeof inspectBusWorkClaims> | undefined;
  let workClaims: UnifiedBusStatus['workClaims'];
  try {
    busClaimsRead = inspectBusWorkClaims(options.root);
    workClaims = { source: busClaimsRead.source,
      claims: busClaimsRead.source === 'available' ? busClaimsRead.claims.length : null };
  } catch {
    workClaims = { source: 'unavailable', claims: null };
  }

  // The drift verdict joins the same two snapshots the sections above
  // report: injected readers keep it on the probe's reads instead of
  // re-reading either store. UNKNOWN nulls every count — the comparison
  // could not run, so reporting zero drift rows would be a lie.
  let claimDrift: UnifiedBusStatus['claimDrift'];
  try {
    const drift = readClaimStoreDrift({ root: options.root, now: now(),
      inspectBus: () => busClaimsRead ?? { source: 'unavailable', claims: [] },
      listCoord: () => coordinationRead ?? { source: 'unavailable', claims: [], statuses: [] } });
    const known = drift.state !== 'UNKNOWN';
    claimDrift = { state: drift.state,
      matched: known ? drift.matched : null,
      busOnly: known ? drift.busOnly.length : null,
      coordOnly: known ? drift.coordOnly.length : null,
      ownerMismatch: known ? drift.ownerMismatch.length : null };
  } catch {
    claimDrift = { state: 'UNKNOWN', matched: null, busOnly: null, coordOnly: null, ownerMismatch: null };
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

  let board: UnifiedBusStatus['board'];
  try {
    board = probeBusBoard(options);
  } catch {
    board = { source: 'unavailable', threads: null, tasks: null, pendingDeliveries: null, claims: null };
  }

  let seats: UnifiedBusStatus['seats'];
  try {
    seats = inspectSeatStore(options.seats?.home);
  } catch {
    seats = { source: 'unavailable', seats: null, states: null, handoffs: null, notices: null };
  }

  // `consumePeerWork` writes the journal and `sendPeerMessage`/`readPeerInbox`
  // keep the coordination ledger under `agentnetPaths().busRoot` —
  // `realHome()/.ashlr/fleet`, deliberately not `ashlrHome()` — unless a
  // `busRoot` override selects another root; the probe resolves the same way
  // and reports unavailable rather than guessing when no real home exists.
  // `realHome()` is total (every resolver path catches), so this stays
  // outside the per-section try blocks without risking the never-throw
  // contract.
  const agentnetHome = realHome();
  const agentnetBusRoot = options.root ?? (agentnetHome === null ? undefined : join(agentnetHome, '.ashlr', 'fleet'));

  let peerDispatch: UnifiedBusStatus['peerDispatch'];
  try {
    const journal = agentnetBusRoot === undefined ? undefined : readWorkDispatchJournal(agentnetBusRoot);
    peerDispatch = journal === undefined || journal.status === 'unavailable'
      ? { source: 'unavailable', receipts: null, unpublished: null }
      : { source: journal.status, receipts: journal.receipts.length,
          unpublished: journal.receipts.filter(receipt => receipt.sent !== receipt.outcome).length };
  } catch {
    peerDispatch = { source: 'unavailable', receipts: null, unpublished: null };
  }

  // The ledger reader folds a missing file and an all-expired ledger into the
  // same 'empty' report, so existence is probed first — the same convention
  // `ownerChat` applies — and a never-written store reports missing rather
  // than available-with-zero.
  let peerLedger: UnifiedBusStatus['peerLedger'];
  try {
    if (agentnetBusRoot === undefined) {
      peerLedger = { source: 'unavailable', liveRows: null };
    } else {
      const report = readPeerLedger({ busRoot: agentnetBusRoot, now });
      peerLedger = report.status === 'unavailable'
        ? { source: 'unavailable', liveRows: null }
        : busPathMissing(join(agentnetBusRoot, 'agentnet', 'coordination.json'))
          ? { source: 'missing', liveRows: 0 }
          : { source: 'available', liveRows: report.liveRows };
    }
  } catch {
    peerLedger = { source: 'unavailable', liveRows: null };
  }

  // The peer plane's auth root and dispatch policy resolve exactly as the
  // peer verbs resolve them: `bindings` is an independent
  // `PeerBusOptions` field — `agentnetPaths().bindings` under realHome(),
  // or the probe's `agentnetBindings` override — that a `busRoot`/`root`
  // override never relocates, and `dispatch.json` is its sibling, the
  // path `consumePeerWork` derives. A sick file here refuses every peer
  // call while the journal and ledger sections stay green. Counts only,
  // never callsigns, session hashes, repo names, tiers or path grants;
  // each inspector is total by contract but keeps its own try so one
  // cannot hide the other's verdict.
  // `agentnetPaths()` itself throws without a real home before any
  // `PeerBusOptions` override applies, so the verbs refuse there too —
  // the override only redirects an otherwise resolvable store.
  const peerBindingsPath = agentnetHome === null ? undefined :
    options.agentnetBindings ?? join(agentnetHome, '.ashlr', 'agentnet', 'bindings.json');
  let peerBindings: UnifiedBusStatus['peerBindings'];
  let peerDispatchPolicy: UnifiedBusStatus['peerDispatchPolicy'];
  if (peerBindingsPath === undefined) {
    peerBindings = { source: 'unavailable', peers: null, active: null };
    peerDispatchPolicy = { source: 'unavailable', peers: null, repositories: null };
  } else {
    try {
      peerBindings = inspectPeerBindings(peerBindingsPath, now());
    } catch {
      peerBindings = { source: 'unavailable', peers: null, active: null };
    }
    try {
      peerDispatchPolicy = inspectPeerDispatchPolicy(peerBindingsPath);
    } catch {
      peerDispatchPolicy = { source: 'unavailable', peers: null, repositories: null };
    }
  }

  // `phm checkpoint handoff list|show` and `fleet_session_handoffs` both
  // serve `listSessionHandoffs` over `<runsRoot>/handoffs` — the same
  // bounded scan under the same runs root the wake probe resolves
  // (`ASHLR_RUNS_DIR` or `~/.ashlr-runs` by default) — so a corrupt
  // journal, unreadable directory or unsafe store is named here instead of
  // leaving status green while those reads report unavailable. Counts
  // only, never job ids, lanes, models or signal payloads; a store the
  // reader cannot inspect reports every count null, matching the
  // unavailable convention the peer-ledger section applies.
  let sessionHandoffs: UnifiedBusStatus['sessionHandoffs'];
  try {
    const list = listSessionHandoffs(options.runsRoot ??
      process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'));
    if (list.status === 'unavailable' || list.handoffs === null) {
      sessionHandoffs = { source: 'unavailable', journals: null, open: null,
        awaitingFailover: null, unreadable: null, truncated: null };
    } else {
      const open = list.handoffs.filter(entry => entry.state === 'open');
      sessionHandoffs = { source: list.status === 'ok' ? 'available' : 'missing',
        journals: list.handoffs.length + (list.unreadable?.length ?? 0),
        open: open.length,
        awaitingFailover: open.filter(entry => handoffPressure(entry.signal)).length,
        unreadable: list.unreadable?.length ?? 0,
        truncated: list.status === 'ok' ? list.truncated : false };
    }
  } catch {
    sessionHandoffs = { source: 'unavailable', journals: null, open: null,
      awaitingFailover: null, unreadable: null, truncated: null };
  }

  // The send gate every bus write passes through. Both readers are total
  // by contract, but each keeps its own try so one throwing probe cannot
  // hide the other's verdict — and an uninspectable source reports
  // unknown, matching the fail-closed rule the send path itself applies
  // (killSwitchOn treats anything but 'inactive' as on, isPaused treats
  // anything but a clean read as paused).
  let kill: UnifiedBusStatus['sendGate']['kill'];
  try {
    const read = readKillSwitch();
    kill = { state: read.state, reason: read.reason };
  } catch {
    kill = { state: 'unknown', reason: 'uninspectable' };
  }
  let pause: UnifiedBusStatus['sendGate']['pause'];
  try {
    pause = probePauseState();
  } catch {
    pause = { state: 'unknown', since: null, reason: 'could not be checked' };
  }
  // 'blocked' needs a positive verdict — kill 'active' or pause 'paused';
  // an 'unknown' sub-state alone leaves the top level 'unknown' because
  // the send path refuses without the probe being able to say which gate
  // or why it is really engaged.
  const killBlocks = kill.state !== 'inactive';
  const pauseBlocks = pause.state !== 'clear';
  const sendGate: UnifiedBusStatus['sendGate'] = {
    state: !killBlocks && !pauseBlocks ? 'open'
      : kill.state === 'active' || pause.state === 'paused' ? 'blocked' : 'unknown',
    kill, pause,
  };

  return { asOf, store, registry, wakes, hoplog, coordination, workClaims, claimDrift, feed, mailbox, ownerChat, board, seats, peerDispatch, peerLedger, peerBindings, peerDispatchPolicy, sessionHandoffs, sendGate };
}
