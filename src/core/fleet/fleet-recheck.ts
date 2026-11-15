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
import { readChannelHealth, type ChannelHealthReport } from './channel-health.js';
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

export type FleetRecheckState = 'VERIFIED' | 'UNKNOWN' | 'BLOCKED';

export type FleetRecheckRuntime = RuntimeIdentity;

export interface FleetRecheckBridge {
  channel: 'slack' | 'imessage';
  state: 'LIVE' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';
  runtimeHost: string | null;
  processAlive: boolean | 'unknown';
  /** First missing reason for this channel, or null when nothing is missing. */
  missingBridge: string | null;
}

export interface FleetRecheckClaim {
  id: string;
  owner: string;
  state: 'RUNNING' | 'ASSIGNED' | 'VERIFIED';
  claimReceipt: string;
  asOf: string;
  source: string;
  ledgerClaim: FleetClaim | null;
  coordinationClaim?: RecheckCoordinationClaim | null;
}

export interface FleetRecheckTask {
  state: FleetRecheckState;
  source: string;
  asOf: string;
  task: FleetRecheckClaim | null;
  unowned: number;
  unclaimed: number;
  lastVerified: {
    id: string;
    owner: string;
    claimReceipt: string;
    asOf: string;
    source: string;
  } | null;
  liveWorker: {
    job: string;
    repo: string;
    lane: string;
    tier: string;
    ageSeconds: number | null;
    asOf: string;
    source: 'process-table';
  } | null;
  missing: string[];
}

export interface FleetRecheckClaims {
  state: FleetRecheckState;
  source: string;
  asOf: string;
  /** Live (unexpired) ledger claims; null when the ledger is unreadable. */
  active: number | null;
  /** Expired-claim count reported by the board; null when unreadable. */
  expiredClaims: number | null;
  /** Newest claims first, capped at TOP_CLAIMS. */
  top: {
    agent: string;
    repo: string;
    task: string;
    expiresAt: string;
  }[];
  claims: {
    id: string;
    agent: string;
    repo: string;
    task: string;
    claimedAt: string;
    expiresAt: string;
    live: boolean;
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
      /** The identity observation's asOf when a read succeeded, else the verdict asOf. */
      asOf: string;
      host: string;
      platform: string;
      tailnetName: string;
      installedVersion: string;
      sourceVersion: string;
      versionDrift: boolean | null;
      fleetState: {
        path: string;
        mtime: string;
        ageSeconds: number | 'unknown';
        stale: boolean | 'unknown';
      };
      reasons: string[];
      missing: string[];
    };
    claims: FleetRecheckClaims;
    bridge: {
      state: FleetRecheckState;
      source: string;
      asOf: string;
      channels: FleetRecheckBridge[];
      /** First missing reason across the report and channels, or null. */
      missingBridge: string | null;
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
export function defaultFleetRecheckDeps(now: () => Date): Required<FleetRecheckDeps> {
  return {
    now,
    homeDir: homedir,
    readRuntimeIdentity: async () => {
      try { return readRuntimeIdentity(defaultRuntimeIdentityDeps()); } catch { return null; }
    },
    readFleetBoard: async () => {
      try { return readFleetBoard(); } catch { return { schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null }; }
    },
    readChannelHealth: () => readChannelHealth(),
    listWorkBoard: async () => {
      try { return listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: Date.now(), limit: 20 }); }
      catch { return { items: [], inbox: 'unavailable' as const, truncated: false }; }
    },
    listCoordination: async () => {
      try {
        const r = listCoordination();
        return { source: r.source, claims: r.claims };
      } catch { return { source: 'unavailable' as const, claims: [] }; }
    },
    listLiveWorkers: () => listLiveWorkers(),
  };
}

export type FleetRecheckDeps = {
  now?: () => Date;
  homeDir?: () => string;
  readRuntimeIdentity?: () => Promise<FleetRecheckRuntime | null>;
  readFleetBoard?: () => Promise<FleetBoard>;
  readChannelHealth?: () => Promise<ChannelHealthReport>;
  listWorkBoard?: () => Promise<WorkBoardResult>;
  listCoordination?: () => Promise<RecheckCoordinationListing>;
  listLiveWorkers?: () => Promise<LiveWorkersSnapshot>;
};

type ReaderResult<T> = { ok: true; value: T } | { ok: false };

function attempt<T>(fn: () => T | Promise<T>): Promise<ReaderResult<T>> {
  return new Promise<ReaderResult<T>>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ ok: false }); }
    }, SECTION_TIMEOUT_MS);
    Promise.resolve()
      .then(fn)
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false });
      });
  });
}

function runtimeObservationFreshness(asOf: string, nowMs: number): string | null {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return 'runtime: asOf malformed';
  if (ms - nowMs > RUNTIME_OBSERVATION_BOUND_MS) return 'runtime: asOf in the future';
  if (nowMs - ms > RUNTIME_OBSERVATION_BOUND_MS) return `runtime: asOf stale (${Math.floor((nowMs - ms) / 1000)}s old)`;
  return null;
}

type RuntimeSection = FleetRecheck['sections']['runtime'];

function runtimeSection(
  read: ReaderResult<FleetRecheckRuntime | null>,
  verdictAsOf: string,
  nowMs: number,
): RuntimeSection {
  const emptyFleetState = { path: '', mtime: '', ageSeconds: 'unknown' as const, stale: 'unknown' as const };
  const section: RuntimeSection = {
    state: 'UNKNOWN',
    source: 'runtime-identity',
    asOf: verdictAsOf,
    host: 'unknown', platform: 'unknown', tailnetName: 'unknown',
    installedVersion: 'unknown', sourceVersion: 'unknown',
    versionDrift: null, fleetState: emptyFleetState, reasons: [],
    missing: ['runtime: reader failed'],
  };
  if (!read.ok || read.value === null) return section;
  const id = read.value;
  section.asOf = typeof id.asOf === 'string' ? id.asOf : verdictAsOf;
  section.host = id.host;
  section.platform = id.platform;
  section.tailnetName = id.tailnetName;
  section.installedVersion = id.installedVersion;
  section.sourceVersion = id.sourceVersion;
  section.versionDrift = id.versionDrift;
  section.fleetState = { ...id.fleetState };
  section.reasons = [...id.reasons];
  // Source reasons are degradation evidence and stay in missing even when the
  // observation itself cannot verify: they precede the freshness verdict.
  const sourceReasons = id.reasons.filter(r => r.length > 0);
  if (!Number.isFinite(nowMs)) {
    section.missing = [...sourceReasons, 'runtime: verdict clock unknown, observation freshness unverifiable'];
    return section;
  }
  const freshness = runtimeObservationFreshness(id.asOf, nowMs);
  if (freshness !== null) {
    // A stale, malformed or future-dated observation cannot verify; the
    // fields and stated reasons stay as evidence beside the freshness reason.
    section.missing = [...sourceReasons, freshness];
    return section;
  }
  // Fresh observation: identity reasons are degradation evidence verbatim,
  // an unknown host with no stated reason still cannot verify, and a stale
  // fleet-state flag is its own missing reason.
  const missing: string[] = [...sourceReasons];
  if ((id.host === 'unknown' || id.host === '') && id.reasons.length === 0) {
    missing.push('host: unknown');
  }
  if (id.fleetState.stale === true) {
    const age = typeof id.fleetState.ageSeconds === 'number' ? `${id.fleetState.ageSeconds}s old` : 'age unknown';
    missing.push(`fleetState: stale (${age})`);
  }
  section.missing = missing;
  section.state = missing.length === 0 ? 'VERIFIED' : 'UNKNOWN';
  return section;
}

function isoOrUnknown(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

function claimsSection(
  read: ReaderResult<FleetBoard>,
  asOf: string,
  nowMs: number,
): FleetRecheckClaims {
  const section: FleetRecheckClaims = {
    state: 'UNKNOWN',
    source: 'fleet-claims',
    asOf,
    active: null,
    expiredClaims: null,
    top: [],
    claims: [],
    missing: ['claims: reader failed'],
  };
  if (!read.ok) return section;
  const ledger = read.value;
  if (ledger.state !== 'known') {
    section.missing = [`claims: ledger state ${ledger.state} (unreadable)`];
    return section;
  }
  if (!Number.isFinite(nowMs)) {
    section.missing = ['claims: verdict clock unknown, claim liveness unverifiable'];
    return section;
  }
  const live = (claim: FleetClaim): boolean =>
    Number.isFinite(claim.claimedAt) && Number.isFinite(claim.expiresAt)
    && claim.expiresAt > claim.claimedAt
    && claim.claimedAt <= nowMs && claim.expiresAt > nowMs;
  const sorted = [...ledger.claims].sort((a, b) => b.claimedAt - a.claimedAt);
  const liveClaims = sorted.filter(live);
  section.active = liveClaims.length;
  section.expiredClaims = ledger.expiredClaims;
  section.top = liveClaims.slice(0, TOP_CLAIMS).map(claim => ({
    agent: claim.agent,
    repo: claim.repo,
    task: claim.task,
    expiresAt: isoOrUnknown(claim.expiresAt),
  }));
  section.claims = liveClaims.slice(0, TOP_CLAIMS).map(claim => ({
    id: claim.id,
    agent: claim.agent,
    repo: claim.repo,
    task: claim.task,
    claimedAt: isoOrUnknown(claim.claimedAt),
    expiresAt: isoOrUnknown(claim.expiresAt),
    live: true,
  }));
  section.state = 'VERIFIED';
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
  return null;
}

type BridgeSection = FleetRecheck['sections']['bridge'];

const REQUIRED_CHANNELS = ['slack', 'imessage'] as const;
const VERDICT_CLOCK_REASON = 'bridge: verdict clock unknown, observation freshness unverifiable';

function bridgeSection(
  read: ReaderResult<ChannelHealthReport>,
  verdictAsOf: string,
  nowMs: number,
): BridgeSection {
  const section: BridgeSection = {
    state: 'UNKNOWN',
    source: 'channel-health',
    asOf: verdictAsOf,
    channels: [],
    missingBridge: null,
    missing: ['bridge: reader failed'],
  };
  if (!read.ok || read.value === null) return section;
  const report = read.value;
  section.asOf = typeof report.asOf === 'string' ? report.asOf : verdictAsOf;
  const nowOk = Number.isFinite(nowMs);
  const byName = new Map((report.channels ?? []).map(c => [c.channel, c]));
  const rows: FleetRecheckBridge[] = [];
  // Missing reasons group as: content gaps, then the report clock, then each
  // channel clock — so a bad report timestamp outranks channel freshness but
  // never outranks a positively identified gap.
  const contentMissing: string[] = [];
  const channelFreshness: string[] = [];
  let blocked = false;
  let allLive = true;
  for (const name of REQUIRED_CHANNELS) {
    const channel = byName.get(name);
    if (channel === undefined) {
      contentMissing.push(`${name} bridge evidence absent`);
      blocked = true;
      allLive = false;
      continue;
    }
    const content: string[] = [...(channel.missing ?? [])];
    // A LIVE observation with no runtime host is a positively identified gap,
    // not a freshness question: the bridge cannot be proven attached.
    const hostGap = channel.state === 'LIVE' && (channel.runtimeHost === null || channel.runtimeHost === '');
    if (hostGap) content.push(`${name} runtime host unknown`);
    contentMissing.push(...content);
    if (content.length > 0 || channel.state === 'BLOCKED' || hostGap) blocked = true;
    if (channel.state !== 'LIVE') allLive = false;
    const fresh = nowOk
      ? observationFreshness(`${name} channel`, channel.asOf, nowMs)
      : VERDICT_CLOCK_REASON;
    if (fresh !== null) channelFreshness.push(fresh);
    rows.push({
      channel: name,
      state: channel.state as FleetRecheckBridge['state'],
      runtimeHost: channel.runtimeHost ?? null,
      processAlive: channel.processAlive,
      missingBridge: content[0] ?? fresh,
    });
  }
  // Extra observed channels ride along as evidence without affecting the verdict.
  for (const channel of report.channels ?? []) {
    if ((REQUIRED_CHANNELS as readonly string[]).includes(channel.channel)) continue;
    rows.push({
      channel: channel.channel as FleetRecheckBridge['channel'],
      state: channel.state as FleetRecheckBridge['state'],
      runtimeHost: channel.runtimeHost ?? null,
      processAlive: channel.processAlive,
      missingBridge: (channel.missing ?? [])[0] ?? null,
    });
  }
  section.channels = rows;
  const reportReason = nowOk
    ? observationFreshness('channel-health report', report.asOf, nowMs)
    : VERDICT_CLOCK_REASON;
  section.missing = [...new Set([
    ...contentMissing,
    ...(reportReason !== null ? [reportReason] : []),
    ...channelFreshness,
  ])];
  section.missingBridge = section.missing[0] ?? null;
  if (blocked) {
    section.state = 'BLOCKED';
  } else if (section.missing.length > 0 || !allLive) {
    section.state = 'UNKNOWN';
    if (section.missing.length === 0) {
      const degraded = rows.find(r => r.state !== 'LIVE');
      if (degraded !== undefined) {
        section.missing = [`bridge: ${degraded.channel} channel ${degraded.state}`];
        section.missingBridge = section.missing[0];
      }
    }
  } else {
    section.state = 'VERIFIED';
    section.missingBridge = null;
  }
  return section;
}

function pickLiveWorker(
  read: ReaderResult<LiveWorkersSnapshot>,
  asOf: string,
): FleetRecheckTask['liveWorker'] {
  if (!read.ok || read.value === null) return null;
  const snapshot = read.value;
  if (snapshot.sourceState !== 'healthy') return null;
  const workers = snapshot.workers ?? [];
  if (workers.length === 0) return null;
  // Phantom repo first, then newest start (smallest age, nulls last), then job id.
  const newest = [...workers].sort((a, b) =>
    (a.repo === 'phantom' ? 0 : 1) - (b.repo === 'phantom' ? 0 : 1)
    || (a.ageSeconds == null ? 1 : 0) - (b.ageSeconds == null ? 1 : 0)
    || (a.ageSeconds ?? 0) - (b.ageSeconds ?? 0)
    || String(a.job).localeCompare(String(b.job)),
  )[0];
  // Process-table fields are untrusted evidence: a repo path can name a home
  // directory the verdict's injected home does not cover, so the home-path
  // shape itself is redacted here, same as the reply formatter does.
  const scrubHome = (value: string): string => value.replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~');
  return {
    job: scrubHome(String(newest.job)),
    repo: scrubHome(String(newest.repo ?? 'unknown')),
    lane: scrubHome(String(newest.lane ?? 'unknown')),
    tier: scrubHome(String(newest.tier ?? 'unknown')),
    ageSeconds: Number.isFinite(newest.ageSeconds) ? newest.ageSeconds : null,
    asOf: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : asOf,
    source: 'process-table',
  };
}

function liveClaimFor(ledger: FleetBoard, owner: string, nowMs: number): FleetClaim | undefined {
  return ledger.claims.find(claim =>
    claim.agent === owner
    && Number.isFinite(claim.claimedAt) && Number.isFinite(claim.expiresAt)
    && claim.claimedAt <= nowMs && claim.expiresAt > nowMs);
}

function taskSection(
  read: ReaderResult<WorkBoardResult>,
  asOf: string,
  ledger: ReaderResult<FleetBoard>,
  nowMs: number,
  coordination: ReaderResult<RecheckCoordinationListing>,
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
    if (!Number.isFinite(nowMs) || !Number.isFinite(ms) || ms > nowMs) continue;
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
      // across two separately written stores. ledgerClaim is not the binding
      // and stays null; the claim-store row is the task identity proof.
      section.state = 'VERIFIED';
      section.task = { ...base, ledgerClaim: null, coordinationClaim: binding.claim };
      section.missing = [];
      return section;
    }
    // An unreadable claims ledger or verdict clock can never verify the
    // owner-claim fallback: both stores must be readable first.
    if (ledgerBoard === undefined || !Number.isFinite(nowMs)) {
      const coordinationReason = coordination.ok && coordination.value.source === 'available'
        ? binding?.reason ?? null
        : null;
      section.state = 'UNKNOWN';
      section.task = { ...base, ledgerClaim: null };
      const text = ledgerBoard === undefined
        ? 'task: claims ledger unreadable, owner claim unverified'
        : 'task: verdict clock unknown, owner claim unverified';
      section.missing = coordinationReason === null ? [text] : [text, coordinationReason];
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
  const base = defaultFleetRecheckDeps(deps.now ?? (() => new Date()));
  const d: Required<FleetRecheckDeps> = { ...base };
  for (const key of Object.keys(deps) as (keyof FleetRecheckDeps)[]) {
    const value = deps[key];
    if (value !== undefined) {
      (d as Record<keyof FleetRecheckDeps, unknown>)[key] = value;
    }
  }
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
    task: taskSection(board, asOf, claims, nowMs, coordination, pickLiveWorker(live, asOf)),
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
