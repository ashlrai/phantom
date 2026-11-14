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
/** Claims listing cap and per-claim task text cap. */
const TOP_CLAIMS = 5;
const TASK_TEXT_MAX = 80;

export type FleetRecheckState = 'VERIFIED' | 'UNKNOWN' | 'BLOCKED';

export interface FleetRecheckRuntime {
  state: FleetRecheckState;
  source: 'runtime-identity';
  asOf: string;
  host: string;
  tailnetName: string;
  installedVersion: string;
  sourceVersion: string;
  fleetState: { ageSeconds: number | 'unknown'; stale: boolean | 'unknown' };
  missing: string[];
}

export interface FleetRecheckClaim {
  agent: string;
  repo: string;
  /** Claim task text truncated to 80 characters. */
  task: string;
  /** ISO expiry of the live claim. */
  expiresAt: string;
}

export interface FleetRecheckClaims {
  state: FleetRecheckState;
  source: 'coordination';
  asOf: string;
  /** Live claim count; null while the ledger is unreadable. */
  active: number | null;
  /** Reaped-claim count from the ledger; null while unreadable. */
  expiredClaims: number | null;
  /** Up to five live claims, newest first. */
  top: FleetRecheckClaim[];
  missing: string[];
}

export interface FleetRecheckBridgeChannel {
  channel: ChannelName;
  /** Raw channel-health state: LIVE | DEGRADED | BLOCKED | UNKNOWN. */
  state: ChannelHealth['state'];
  runtimeHost: string | null;
  processAlive: boolean | 'unknown';
  /** Exact reason a channel does not verify: its missing[] entry, or the
   * freshness failure when the observed state was live but unverifiable. */
  missingBridge: string | null;
}

export interface FleetRecheckBridge {
  state: FleetRecheckState;
  source: 'channel-health';
  asOf: string;
  channels: FleetRecheckBridgeChannel[];
  /** First non-verified channel's missing entry — the bridge to name in a reply. */
  missingBridge: string | null;
  missing: string[];
}

export interface FleetRecheckTaskPick {
  id: string;
  state: 'RUNNING' | 'ASSIGNED';
  owner: string;
  claimReceipt: string;
  /** Live ledger claim held by owner; null unless the join found one. */
  ledgerClaim: { id: string; repo: string; expiresAt: string } | null;
  /** Claim-store row bound to this item by owner, receipt coordinates and a
   * live lease; present only when the task section VERIFIED on it. */
  coordinationClaim?: RecheckCoordinationClaim;
  asOf: string;
  source: string;
}

export interface FleetRecheckTask {
  state: FleetRecheckState;
  source: 'work-board';
  asOf: string;
  task: FleetRecheckTaskPick | null;
  /** RUNNING/ASSIGNED candidates lacking a named owner. */
  unowned: number;
  /** RUNNING/ASSIGNED candidates lacking a claim receipt. */
  unclaimed: number;
  missing: string[];
}

export interface FleetRecheck {
  schema: typeof FLEET_RECHECK_SCHEMA;
  asOf: string;
  sections: {
    runtime: FleetRecheckRuntime;
    claims: FleetRecheckClaims;
    bridge: FleetRecheckBridge;
    task: FleetRecheckTask;
  };
  overall: { state: FleetRecheckState; missing: string[] };
}

/** Every reader injectable; omitted readers fall back to the live modules. */
export interface FleetRecheckDeps {
  now?: () => Date;
  /** Home directory, used only to redact it from output. */
  homeDir?: () => string;
  readRuntimeIdentity?: () => RuntimeIdentity | Promise<RuntimeIdentity>;
  readChannelHealth?: () => ChannelHealthReport | Promise<ChannelHealthReport>;
  readFleetBoard?: () => FleetBoard | Promise<FleetBoard>;
  listWorkBoard?: () => WorkBoardResult | Promise<WorkBoardResult>;
  /** Claim-store listing used to bind the task pick to its bus work claim. */
  listCoordination?: () => RecheckCoordinationListing | Promise<RecheckCoordinationListing>;
}

/** Live readers, wired exactly as the standalone fleet commands wire them. */
export function defaultFleetRecheckDeps(now: () => Date = () => new Date()): Required<FleetRecheckDeps> {
  return {
    now,
    homeDir: () => homedir(),
    readRuntimeIdentity: () => readRuntimeIdentity(defaultRuntimeIdentityDeps()),
    readChannelHealth: () => readChannelHealth(),
    readFleetBoard: () => readFleetBoard(),
    listWorkBoard: () => listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: now().getTime() }),
    // Default root is the same ~/.ashlr/fleet directory listWorkBoard reads.
    listCoordination: () => listCoordination(undefined, now().getTime()),
  };
}

/** Run one reader inside the section bound; a throw or stall is a section failure, never a crash. */
async function attempt<T>(read: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('section reader timed out')), SECTION_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function runtimeSection(read: { ok: true; value: RuntimeIdentity } | { ok: false }, asOf: string): FleetRecheckRuntime {
  const section: FleetRecheckRuntime = {
    state: 'UNKNOWN', source: 'runtime-identity', asOf,
    host: UNKNOWN, tailnetName: UNKNOWN, installedVersion: UNKNOWN, sourceVersion: UNKNOWN,
    fleetState: { ageSeconds: 'unknown', stale: 'unknown' }, missing: ['runtime: reader failed'],
  };
  if (!read.ok) return section;
  const id = read.value;
  section.asOf = id.asOf;
  section.host = id.host;
  section.tailnetName = id.tailnetName;
  section.installedVersion = id.installedVersion;
  section.sourceVersion = id.sourceVersion;
  section.fleetState = { ageSeconds: id.fleetState.ageSeconds, stale: id.fleetState.stale };
  // VERIFIED only when a real host answers and the fleet-state read is fresh.
  if (id.host !== UNKNOWN && id.fleetState.stale === false) {
    section.state = 'VERIFIED';
    section.missing = [];
    return section;
  }
  section.missing = [...id.reasons];
  if (section.missing.length === 0) {
    section.missing.push(id.fleetState.stale === true
      ? `fleetState: stale (${id.fleetState.ageSeconds}s old)`
      : `fleetState: freshness ${id.fleetState.stale}`);
  }
  return section;
}

/** A claim is live at the verdict only with finite, ordered timestamps and
 * claimedAt <= now < expiresAt; future, expired and malformed rows never count. */
function claimLiveAt(claim: FleetClaim, nowMs: number): boolean {
  return Number.isFinite(claim.claimedAt) && Number.isFinite(claim.expiresAt)
    && claim.expiresAt > claim.claimedAt
    && claim.claimedAt <= nowMs && nowMs < claim.expiresAt;
}

function claimsSection(
  read: { ok: true; value: FleetBoard } | { ok: false },
  asOf: string,
  nowMs: number,
): FleetRecheckClaims {
  const section: FleetRecheckClaims = {
    state: 'UNKNOWN', source: 'coordination', asOf,
    active: null, expiredClaims: null, top: [], missing: ['claims: reader failed'],
  };
  if (!read.ok) return section;
  const board = read.value;
  if (board.state !== 'known') {
    section.missing = ['claims: ledger state unknown (unreadable)'];
    return section;
  }
  // An unreadable verdict clock leaves claim liveness unverifiable: keep the
  // ledger-supplied reaped count but never report a VERIFIED count or listing.
  if (!Number.isFinite(nowMs)) {
    section.expiredClaims = board.expiredClaims;
    section.missing = ['claims: verdict clock unknown, claim liveness unverifiable'];
    return section;
  }
  section.state = 'VERIFIED';
  section.missing = [];
  const live = board.claims.filter(claim => claimLiveAt(claim, nowMs));
  section.active = live.length;
  section.expiredClaims = board.expiredClaims ?? 0;
  section.top = [...live]
    .sort((a, b) => b.claimedAt - a.claimedAt || b.expiresAt - a.expiresAt)
    .slice(0, TOP_CLAIMS)
    .map(claim => ({
      agent: claim.agent,
      repo: claim.repo,
      task: claim.task.slice(0, TASK_TEXT_MAX),
      expiresAt: new Date(claim.expiresAt).toISOString(),
    }));
  return section;
}

function bridgeChannelView(channel: ChannelHealth): FleetRecheckBridgeChannel {
  const verified = channel.state === 'LIVE' && channel.runtimeHost !== null;
  return {
    channel: channel.channel,
    state: channel.state,
    runtimeHost: channel.runtimeHost,
    processAlive: channel.processAlive,
    // Name the exact missing piece for a non-verified channel; missing[] can be
    // empty on a bare DEGRADED, so fall back to the observed state itself.
    missingBridge: verified ? null : channel.missing[0] ?? `${channel.channel} bridge ${channel.state.toLowerCase()}`,
  };
}

/**
 * A channel observation can only be evidence for this verdict when it was
 * captured inside the reader's own bound: SECTION_TIMEOUT_MS in either
 * direction of the captured verdict clock. An older asOf is a historical
 * snapshot and a newer one is future-dated — neither may verify a bridge.
 */
const BRIDGE_OBSERVATION_BOUND_MS = SECTION_TIMEOUT_MS;

/** Exact freshness failure for one observation timestamp; null when within
 * BRIDGE_OBSERVATION_BOUND_MS of the verdict clock. */
function observationFreshness(label: string, asOf: string, nowMs: number): string | null {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return `bridge: ${label} asOf malformed`;
  if (ms - nowMs > BRIDGE_OBSERVATION_BOUND_MS) return `bridge: ${label} asOf in the future`;
  if (nowMs - ms > BRIDGE_OBSERVATION_BOUND_MS) {
    return `bridge: ${label} asOf stale (${Math.floor((nowMs - ms) / 1000)}s old)`;
  }
  return null;
}

function bridgeSection(
  read: { ok: true; value: ChannelHealthReport } | { ok: false },
  asOf: string,
  nowMs: number,
): FleetRecheckBridge {
  const section: FleetRecheckBridge = {
    state: 'UNKNOWN', source: 'channel-health', asOf,
    channels: [], missingBridge: null, missing: ['bridge: reader failed'],
  };
  if (!read.ok) return section;
  const report = read.value;
  section.asOf = report.asOf;
  const names = ['slack', 'imessage'] as const;
  section.channels = names.map(name => {
    const channel = report.channels.find(c => c.channel === name);
    return channel !== undefined
      ? bridgeChannelView(channel)
      : { channel: name, state: 'UNKNOWN' as const, runtimeHost: null, processAlive: 'unknown' as const, missingBridge: `${name} bridge evidence absent` };
  });
  // Positively identified gaps (absent channel, or a state that is not
  // verified live) keep their exact reason and stay BLOCKED.
  const gaps = section.channels.map(c => c.missingBridge).filter((m): m is string => m !== null);
  // Freshness is bounded against the captured verdict clock, not the report's
  // own wrapper timestamp: a fresh report.asOf cannot launder an old channel
  // observation, and a stale report makes every channel inside unverifiable.
  // A freshness failure can only stop a would-be VERIFIED observation — it
  // never erases a known gap.
  const freshness: string[] = [];
  if (!Number.isFinite(nowMs)) {
    freshness.push('bridge: verdict clock unknown, observation freshness unverifiable');
  } else {
    const reportReason = observationFreshness('channel-health report', report.asOf, nowMs);
    if (reportReason !== null) freshness.push(reportReason);
    names.forEach((name, i) => {
      const view = section.channels[i]!;
      if (view.missingBridge !== null) return; // a known gap needs no freshness verdict
      const channel = report.channels.find(c => c.channel === name);
      if (channel === undefined) return;
      const reason = observationFreshness(`${name} channel`, channel.asOf, nowMs);
      if (reason !== null) {
        view.missingBridge = reason;
        freshness.push(reason);
      }
    });
  }
  section.missing = [...gaps, ...freshness];
  section.missingBridge = section.missing[0] ?? null;
  // VERIFIED only when every channel is LIVE on a named runtime host and every
  // observation timestamp is provably inside the verdict's freshness bound.
  section.state = gaps.length > 0 ? 'BLOCKED' : freshness.length > 0 ? 'UNKNOWN' : 'VERIFIED';
  return section;
}

/** Newest claim for owner that is live at the verdict's captured now; expiry and start are both judged against it. */
function liveClaimFor(board: FleetBoard, owner: string, nowMs: number): FleetClaim | undefined {
  let best: FleetClaim | undefined;
  for (const claim of board.claims) {
    if (claim.agent !== owner || !claimLiveAt(claim, nowMs)) continue;
    if (best === undefined || claim.claimedAt > best.claimedAt) best = claim;
  }
  return best;
}

function taskSection(
  read: { ok: true; value: WorkBoardResult } | { ok: false },
  asOf: string,
  ledger: { ok: true; value: FleetBoard } | { ok: false },
  nowMs: number,
  coordination: { ok: true; value: RecheckCoordinationListing } | { ok: false },
): FleetRecheckTask {
  const section: FleetRecheckTask = {
    state: 'UNKNOWN', source: 'work-board', asOf,
    task: null, unowned: 0, unclaimed: 0, missing: ['task: reader failed'],
  };
  if (!read.ok) return section;
  const board = read.value;
  if (board.inbox !== 'ok') {
    section.state = 'BLOCKED';
    section.missing = [`task: work board inbox ${board.inbox}`];
    return section;
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

  // All five readers run concurrently, each inside its own 5 s bound.
  const [runtime, claims, bridge, board, coordination] = await Promise.all([
    attempt(d.readRuntimeIdentity),
    attempt(d.readFleetBoard),
    attempt(d.readChannelHealth),
    attempt(d.listWorkBoard),
    attempt(d.listCoordination),
  ]);

  const sections = {
    runtime: runtimeSection(runtime, asOf),
    claims: claimsSection(claims, asOf, nowMs),
    bridge: bridgeSection(bridge, asOf, nowMs),
    task: taskSection(board, asOf, claims, nowMs, coordination),
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
