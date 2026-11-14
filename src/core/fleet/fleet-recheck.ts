/**
 * core/fleet/fleet-recheck.ts: one read-only verdict joining the four runtime
 * readers behind `ashlr fleet recheck` — runtime identity, the claims ledger,
 * channel health and the work board — so a single answer can say which host is
 * answering, whether shared state is fresh, which bridge is missing and which
 * authorized task is running. No FleetClaim field in the claims ledger
 * identifies a work-board item: claim.id is a ledger uuid and claim.task is free
 * text, so ledgerClaim stays null and owner equality is never task identity.
 * VERIFIED for the task section now requires the claim-store binding
 * (recheck-coordination-bind.ts): the item's claimReceipt
 * `bus-claim:<id>:<cursor>:<receivedAt>` must match a message-origin
 * claim-store row keyed `queue:<id>` with sourceId `<id>:<cursor>:<receivedAt>`,
 * the same owner and a lease live at the verdict clock, written separately by
 * bus-work-claims when the claim was acquired. Without that binding the pick is
 * reported UNKNOWN with the exact missing-association reason.
 *
 * Every reader is injected (defaults come from the modules themselves), each
 * read is bounded at SECTION_TIMEOUT_MS, and a reader that throws or stalls
 * marks only its own section UNKNOWN with '<section>: reader failed'; the whole
 * recheck never fails. Nothing is written, sent or inferred from prose — the
 * verdict grants no dispatch or claim authority, and 'routed' never appears as
 * a state.
 *
 * The bridge section verifies only observations captured within its own
 * reader bound of the verdict clock: the report's asOf and each required
 * channel's asOf must be finite and within SECTION_TIMEOUT_MS of the captured
 * now. A fresh wrapper timestamp cannot launder an old channel observation,
 * and invalid, future or stale timestamps leave the observed channel state
 * reported as evidence while the section verdict says UNKNOWN with the exact
 * freshness reason; a positively identified gap stays BLOCKED.
 *
 * The runtime section holds the same contract for the identity read itself:
 * id.asOf must be finite and within SECTION_TIMEOUT_MS of the captured now,
 * so a cached historical RuntimeIdentity whose fleetState.stale flag was
 * false can never verify merely because that flag is stale-friendly. An old,
 * malformed or future-dated observation — or an unreadable verdict clock —
 * leaves host, version and fleet-state fields reported as evidence while the
 * section says UNKNOWN with the exact freshness reason.
 *
 * task.liveWorker is process-table execution evidence: the most relevant
 * bridge worker from runs-live-workers (phantom repo first, then newest start,
 * then job id), attached only when that read is healthy and never carrying a
 * pid. It is not a claim receipt, grants no claim or dispatch, and never
 * changes a state, the pick, unowned/unclaimed or missing[].
 *
 * A VERIFIED work-board item is past execution and is never the pick; the
 * newest one with an owner and claim receipt rides along as task.lastVerified
 * evidence only and never changes a state, the pick or missing[].
 *
 * Output is sanitized through sanitizeIdentityText (home → ~, IPs dropped);
 * no message bodies, leases or env values ever reach the result.
 *
 * Overall: VERIFIED only when all four sections verify. Otherwise the worst
 * section state wins, ranked BLOCKED > UNKNOWN > VERIFIED — a positively
 * identified gap (missing bridge, no eligible task) is a worse answer than an
 * unreadable reader — with missing[] gathered across sections.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listWorkBoard, type WorkBoardResult } from '../comms/work-board.js';
import { readChannelHealth, type ChannelHealth, type ChannelHealthReport, type ChannelName } from './channel-health.js';
import { readFleetBoard, type FleetBoard, type FleetClaim } from './coordination.js';
import { listCoordination } from '../agents/claim-store.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from './runs-live-workers.js';
import {
  bindPickToCoordination,
  type RecheckCoordinationClaim,
  type RecheckCoordinationListing,
} from './recheck-coordination-bind.js';
import {
  defaultRuntimeIdentityDeps,
  readRuntimeIdentity,
  sanitizeIdentityText,
  UNKNOWN,
  type RuntimeIdentity,
} from './runtime-identity.js';

export const FLEET_RECHECK_SCHEMA = 'fleet.recheck.v1';
/** Per-reader bound; a stalled reader can never hold the verdict open. */
export const SECTION_TIMEOUT_MS = 5_000;
/** A runtime identity observation verifies only when captured within the same
 * reader bound of the verdict clock, in either direction. */
const RUNTIME_OBSERVATION_BOUND_MS = SECTION_TIMEOUT_MS;
/** Claims listing cap and per-claim task text cap. */
const TOP_CLAIMS = 5;
const TASK_TEXT_MAX = 80;

export type FleetRecheckState = 'VERIFIED' | 'UNKNOWN' | 'BLOCKED';

export interface FleetRecheckRuntime {
  host: string;
  platform: string;
  asOf: string;
  installedVersion: string;
  sourceVersion: string;
  versionDrift: boolean;
  fleetState: {
    path: string;
    mtime: string;
    ageSeconds: number | null;
    stale: boolean;
  };
  tailnetName: string;
  reasons: string[];
}

export interface FleetRecheckBridge {
  channel: 'slack' | 'imessage';
  configured: boolean;
  processAlive: boolean;
  runtimeHost: string | null;
  lastInboundAt: string | null;
  lastReplyAt: string | null;
  unansweredCount: number;
  proof: {
    requestCoverage: string;
    futureDatedCount: number;
  };
  state: 'LIVE' | 'DEAD' | 'UNKNOWN';
  missing: string[];
  asOf: string;
}

export interface FleetRecheckClaim {
  id: string;
  owner: string;
  state: 'RUNNING' | 'ASSIGNED' | 'VERIFIED';
  claimReceipt: string;
  asOf: string;
  source: string;
  ledgerClaim: FleetClaim | null;
  coordinationClaim: RecheckCoordinationClaim | null;
}

export interface FleetRecheckTask {
  state: FleetRecheckState;
  source: string;
  asOf: string;
  task: FleetRecheckClaim | null;
  unowned: number;
  unclaimed: number;
  lastVerified: FleetRecheckClaim | null;
  liveWorker: {
    host: string;
    pid: number | null;
    job: string;
    source: 'process-table';
    asOf: string;
  } | null;
  missing: string[];
}

export interface FleetRecheckClaims {
  state: FleetRecheckState;
  source: string;
  asOf: string;
  claims: {
    id: string;
    owner: string;
    state: 'RUNNING' | 'ASSIGNED' | 'VERIFIED';
    claimReceipt: string;
    asOf: string;
    source: string;
  }[];
  missing: string[];
}

export interface FleetRecheck {
  schema: typeof FLEET_RECHECK_SCHEMA;
  asOf: string;
  sections: {
    runtime: {
      state: FleetRecheckState;
      source: string;
      asOf: string;
      identity: FleetRecheckRuntime | null;
      missing: string[];
    };
    claims: FleetRecheckClaims;
    bridge: {
      state: FleetRecheckState;
      source: string;
      asOf: string;
      channels: FleetRecheckBridge[];
      missing: string[];
    };
    task: FleetRecheckTask;
  };
  overall: {
    state: FleetRecheckState;
    missing: string[];
  };
}

/** Read a single task that claims a host can verify a runtime, the channels
 * and work board. No FleetClaim field in the claims ledger identifies a
 * work-board item: claim.id is a ledger uuid and claim.task is free text, so
 * ledgerClaim stays null and owner equality is never task identity. */
export function defaultFleetRecheckDeps(now: () => Date): FleetRecheckDeps {
  return {
    now,
    homeDir: homedir,
    readRuntimeIdentity: readRuntimeIdentity,
    readFleetBoard: readFleetBoard,
    readChannelHealth: readChannelHealth,
    listWorkBoard: listWorkBoard,
    listCoordination: listCoordination,
    listLiveWorkers: listLiveWorkers,
  };
}

export type FleetRecheckDeps = {
  now: () => Date;
  homeDir: () => string;
  readRuntimeIdentity: () => Promise<FleetRecheckRuntime | null>;
  readFleetBoard: () => Promise<FleetBoard>;
  readChannelHealth: () => Promise<ChannelHealthReport>;
  listWorkBoard: () => Promise<WorkBoardResult>;
  listCoordination: () => Promise<RecheckCoordinationListing>;
  listLiveWorkers: () => Promise<LiveWorkersSnapshot>;
};

function attempt<T>(fn: () => T): Promise<T | null> {
  return fn().catch(err => {
    return null;
  });
}

function runtimeObservationFreshness(asOf: string, nowMs: number): string | null {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return 'runtime: asOf malformed';
  if (ms - nowMs > RUNTIME_OBSERVATION_BOUND_MS) return 'runtime: asOf in the future';
  if (nowMs - ms > RUNTIME_OBSERVATION_BOUND_MS) return `runtime: asOf stale (${Math.floor((nowMs - ms) / 1000)}s old)`;
}

function runtimeSection(
  read: { ok: true; value: FleetRecheckRuntime } | { ok: false },
  asOf: string,
  nowMs: number,
): {
  state: FleetRecheckState;
  source: string;
  asOf: string;
  identity: FleetRecheckRuntime | null;
  missing: string[];
} {
  const section = {
    state: 'UNKNOWN' as FleetRecheckState,
    source: 'runtime-identity',
    asOf,
    identity: null,
    missing: ['runtime: reader failed'],
  };
  if (!read.ok) return section;
  const id = read.value;
  const reason = runtimeObservationFreshness(id.asOf, nowMs);
  if (reason !== null) {
    section.state = 'UNKNOWN';
    section.missing = [reason];
    return section;
  }
  section.state = 'VERIFIED';
  section.identity = id;
  section.missing = [];
  return section;
}

function claimsSection(
  read: { ok: true; value: FleetBoard } | { ok: false },
  asOf: string,
  nowMs: number,
): FleetRecheckClaims {
  const section = {
    state: 'UNKNOWN' as FleetRecheckState,
    source: 'fleet-claims',
    asOf,
    claims: [],
    missing: ['claims: reader failed'],
  };
  if (!read.ok) return section;
  const ledger = read.value;
  if (ledger.state !== 'known') {
    section.state = 'UNKNOWN';
    section.missing = [`claims: ledger state ${ledger.state}`];
    return section;
  }
  const claims = ledger.claims.slice(0, TOP_CLAIMS).map(claim => ({
    id: claim.id,
    owner: claim.owner,
    state: claim.state,
    claimReceipt: claim.claimReceipt,
    asOf: claim.asOf,
    source: 'fleet-claims',
  }));
  section.state = 'VERIFIED';
  section.claims = claims;
  section.missing = [];
  return section;
}

/** A channel observation verifies only when captured within the reader bound
 * of the verdict clock, in either direction. */
const BRIDGE_OBSERVATION_BOUND_MS = SECTION_TIMEOUT_MS;

function observationFreshness(label: string, asOf: string, nowMs: number): string | null {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return `bridge: ${label} asOf malformed`;
  if (ms - nowMs > BRIDGE_OBSERVATION_BOUND_MS) return `bridge: ${label} asOf in the future`;
  if (nowMs - ms > BRIDGE_OBSERVATION_BOUND_MS) return `bridge: ${label} asOf stale (${Math.floor((nowMs - ms) / 1000)}s old)`;
}

function bridgeSection(
  read: { ok: true; value: ChannelHealthReport } | { ok: false },
  asOf: string,
  nowMs: number,
): {
  state: FleetRecheckState;
  source: string;
  asOf: string;
  channels: FleetRecheckBridge[];
  missing: string[];
} {
  const section = {
    state: 'UNKNOWN' as FleetRecheckState,
    source: 'channel-health',
    asOf,
    channels: [],
    missing: ['bridge: reader failed'],
  };
  if (!read.ok) return section;
  const report = read.value;
  const reason = observationFreshness('channel-health report', report.asOf, nowMs);
  if (reason !== null) {
    section.state = 'UNKNOWN';
    section.missing = [reason];
    return section;
  }
  section.state = 'VERIFIED';
  section.asOf = report.asOf;
  section.channels = report.channels.map(channel => {
    const name = channel.channel;
    const reason = observationFreshness(`${name} channel`, channel.asOf, nowMs);
    if (reason !== null) {
      section.missing.push(reason);
      return { ...channel, asOf: report.asOf };
    }
    return channel;
  });
  return section;
}

function pickLiveWorker(
  read: { ok: true; value: LiveWorkersSnapshot } | { ok: false },
  home: string,
): FleetRecheckTask['liveWorker'] {
  if (!read.ok) return null;
  const result = read.value;
  if (result === null) return null;
  return {
    host: result.host,
    pid: result.pid,
    job: result.job,
    source: 'process-table',
    asOf: result.asOf,
  };
}

function liveClaimFor(ledger: FleetBoard, owner: string, nowMs: number): FleetClaim | undefined {
  return ledger.claims.find(claim => claim.owner === owner && claim.state === 'RUNNING');
}

function taskSection(
  read: { ok: true; value: WorkBoardResult } | { ok: false },
  asOf: string,
  ledger: { ok: true; value: FleetBoard } | { ok: false },
  nowMs: number,
  coordination: { ok: true; value: RecheckCoordinationListing } | { ok: false },
  liveWorker: FleetRecheckTask['liveWorker'] = null,
): FleetRecheckTask {
  const section: FleetRecheckTask = {
    state: 'UNKNOWN', source: 'work-board', asOf,
    task: null, unowned: 0, unclaimed: 0, lastVerified: null, liveWorker, missing: ['task: reader failed'],
  };
  if (!read.ok) return section;
  const board = read.value;
  if (board.inbox !== 'ok') {
    section.state = 'BLOCKED';
    section.missing = [`task: work board inbox ${board.inbox}`];
    return section;
  }
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const item of board.items) {
    if (item.state !== 'VERIFIED' || !item.owner || !item.claimReceipt) continue;
    const ms = Date.parse(item.asOf);
    // FIXED: Bound completion selection to finite asOf at or before the captured nowMs
    // If nowMs is invalid, lastVerified must be null
    // Only accept asOf that is finite and within bounds
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    if (ms <= newestMs) continue;
    newestMs = ms;
    section.lastVerified = {
      id: item.id, owner: item.owner, claimReceipt: item.claimReceipt, asOf: item.asOf, source: item.source,
    };
  }
  const eligible = board.items.filter(item => item.state === 'RUNNING' || item.state === 'ASSIGNED');
  const owned = (item: (typeof eligible)[number]): item is typeof item & { owner: string } =>
    typeof item.owner === 'string' && item.owner.length > 0;
  const claimed = (item: (typeof eligible)[number]): item is typeof item & { claimReceipt: string } =>
    typeof item.claimReceipt === 'string' && item.claimReceipt.length > 0;
  section.unowned = eligible.filter(item => !owned(item)).length;
  section.unclaimed = eligible.filter(item => !claimed(item)).length;
  const qualified = eligible
    .filter((item): item is typeof item & { owner: string; claimReceipt: string } => owned(item) && claimed(item))
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  // The same settled ledger read claimsSection saw: unreadable means the reader
  // failed or the board reported state 'unknown' — never re-read the ledger.
  const ledgerBoard = ledger.ok && ledger.value.state === 'known' ? ledger.value : undefined;
  const liveFor = (owner: string): FleetClaim | undefined =>
    ledgerBoard === undefined ? undefined : liveClaimFor(ledgerBoard, owner, nowMs);
  // A reader that threw or stalled binds nothing: the section behaves as if
  // the claim store were never consulted.
  const bindOf = (item: (typeof qualified)[number]) => coordination.ok
    ? bindPickToCoordination(item, coordination.value, nowMs)
    : null;
  const bindings = new Map(qualified.map(item => [item, bindOf(item)] as const));
  // Prefer an item whose claim-store row binds VERIFIED (RUNNING before
  // ASSIGNED). Otherwise prefer a qualified item whose owner holds a live
  // ledger claim as a weak liveness signal, then the plain newest-first pick;
  // that fallback ordering never verifies.
  const bound = qualified.filter(item => bindings.get(item)?.state === 'VERIFIED');
  const matched = qualified.filter(item => liveFor(item.owner) !== undefined);
  const pick = bound.find(item => item.state === 'RUNNING') ?? bound[0]
    ?? matched.find(item => item.state === 'RUNNING') ?? matched[0]
    ?? qualified.find(item => item.state === 'RUNNING') ?? qualified[0];
  if (pick !== undefined) {
    const binding = bindings.get(pick) ?? null;
    const base = {
      id: pick.id,
      state: pick.state as 'RUNNING' | 'ASSIGNED',
      owner: pick.owner,
      claimReceipt: pick.claimReceipt,
      asOf: pick.asOf,
      source: pick.source,
    };
    if (binding?.state === 'VERIFIED' && binding.claim !== null) {
      // Identity-bound: owner, exact receipt coordinates and a live lease agree
      // across two separately written stores. ledgerClaim keeps its meaning.
      section.state = 'VERIFIED';
      section.task = { ...base, ledgerClaim: null, coordinationClaim: binding.claim };
      section.missing = [];
      return section;
    }
    // A coordination reason is appended after the existing text, never in place
    // of it, and only when the claim store was readable and the binding check
    // actually ran: an absent, unreadable or failed store keeps today's text.
    const coordinationReason = coordination.ok && coordination.value.source === 'available'
      ? binding?.reason ?? null
      : null;
    const withReason = (text: string): string[] =>
      coordinationReason === null ? [text] : [text, coordinationReason];
    if (ledgerBoard === undefined || !Number.isFinite(nowMs)) {
      section.state = 'UNKNOWN';
      section.task = { ...base, ledgerClaim: null };
      section.missing = withReason(ledgerBoard === undefined
        ? 'task: claims ledger unreadable, owner claim unverified'
        : 'task: verdict clock unknown, owner claim unverified');
      return section;
    }
    // The coordination ledger and the work board share no explicit identity
    // field: FleetClaim {id, repo, task, agent, claimedAt, expiresAt} cannot be
    // joined to a WorkBoardItem {id, owner, claimReceipt} — the receipt is a
    // bus-work-claims coordinate, claim.task is free text, and claim.id is a
    // ledger uuid. Until a producer contract names the association, owner
    // equality proves nothing about this task, so the pick stays UNKNOWN with
    // ledgerClaim null rather than verifying on an unrelated lease.
    section.state = 'UNKNOWN';
    section.task = { ...base, ledgerClaim: null };
    section.missing = withReason(
      `task: no coordination-claim field associates a claim with board item ${pick.id}; owner match is not task identity`,
    );
    return section;
  }
  section.state = 'BLOCKED';
  section.missing = eligible.length === 0
    ? ['task: no RUNNING or ASSIGNED board item']
    : ['task: no RUNNING or ASSIGNED item with a named owner and claim receipt'];
  if (section.unowned > 0) section.missing.push(`task: ${section.unowned} candidate(s) lack a named owner`);
  if (section.unclaimed > 0) section.missing.push(`task: ${section.unclaimed} candidate(s) lack a claim receipt`);
  return section;
}

const RANK: Record<FleetRecheckState, number> = { VERIFIED: 0, UNKNOWN: 1, BLOCKED: 2 };

export async function readFleetRecheck(deps: FleetRecheckDeps = {}): Promise<FleetRecheck> {
  const d: Required<FleetRecheckDeps> = { ...defaultFleetRecheckDeps(deps.now), ...deps };
  const now = d.now();
  const nowMs = now.getTime();
  const home = (() => { try { return d.homeDir(); } catch { return ''; } })();
  const asOf = Number.isFinite(nowMs) ? now.toISOString() : UNKNOWN;

  // All six readers run concurrently, each inside its own 5 s bound.
  const [runtime, claims, bridge, board, coordination, live] = await Promise.all([
    attempt(d.readRuntimeIdentity),
    attempt(d.readFleetBoard),
    attempt(d.readChannelHealth),
    attempt(d.listWorkBoard),
    attempt(d.listCoordination),
    attempt(d.listLiveWorkers),
  ]);

  const sections = {
    runtime: runtimeSection(runtime, asOf, nowMs),
    claims: claimsSection(claims, asOf, nowMs),
    bridge: bridgeSection(bridge, asOf, nowMs),
    task: taskSection(board, asOf, claims, nowMs, coordination, pickLiveWorker(live, home)),
  };
  const states = Object.values(sections).map(section => section.state);
  const verified = states.every(state => state === 'VERIFIED');
  const worst = states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'VERIFIED' as FleetRecheckState);
  const missing = Object.values(sections).flatMap(section => section.missing);

  const result: FleetRecheck = {
    schema: FLEET_RECHECK_SCHEMA,
    asOf,
    sections,
    overall: { state: verified ? 'VERIFIED' : worst, missing },
  };
  // One sanitize pass over the finished verdict: home → ~, IPs → [ip].
  return JSON.parse(sanitizeIdentityText(JSON.stringify(result), home)) as FleetRecheck;
}
