/**
 * Local, observation-only fleet views. Deliberately reuse the CLI's persisted
 * readers rather than buildFleetStatus: that broader view probes providers,
 * companion CLIs and remote protection settings. No dispatch or repair here.
 */
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { loadDaemonStateStrict } from '../core/daemon/state.js';
import { readDaemonPause } from '../core/daemon/pause.js';
import { probeDaemonLiveness } from '../core/daemon/liveness.js';
import { readFleetDaemonStatus } from '../core/fleet/status.js';
import { fleetBudget } from '../core/fleet/budget-view.js';
import { evalFleetQuotaAuthority, inspectFleetQuotaAuthority } from '../core/fleet/quota.js';
import { loadBacklog } from '../core/portfolio/backlog.js';
import { listProposalsDetailed } from '../core/inbox/store.js';
import { readKillSwitch } from '../core/sandbox/policy.js';
import { BUILTIN_ENGINE_REGISTRY } from '../core/run/engine-registry.js';
import { BUS_HOPLOG_TAIL_MAX_ROWS, readBusHoplogTail } from '../core/fleet/bus-hoplog.js';
import { summarizeBusHops } from '../core/fleet/bus-hop-summary.js';
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { agentRefAddressMatcher, readAgentRegistry } from '../core/agents/bus-identity.js';

export const MAX_FLEET_TICKS = 50;
export const MAX_FLEET_BUS_HOPS = 50;

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function tickBackendCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([backend, count]) =>
    Object.hasOwn(BUILTIN_ENGINE_REGISTRY, backend) && nonnegativeNumber(count) !== null,
  ));
}

/** No caller-selected paths, commands, environments, or config overrides. */
export async function readFleetLoop(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_TICKS) {
    throw new RangeError('Tick limit must be an integer between 1 and 50.');
  }
  const cfg = loadConfigReadOnlyStrict();
  const state = loadDaemonStateStrict({ preserveOwnerIdentity: true });
  const { daemon, recentTicks } = await readFleetDaemonStatus();
  const pause = readDaemonPause();
  const kill = readKillSwitch();
  // A recorded running flag is a claim, not proof of process identity. Passing
  // the strict read also bypasses the liveness cache across successive calls.
  const liveness = probeDaemonLiveness({ recorded: state.ok ? {
    running: state.state.running,
    pid: state.state.pid ?? null,
    startedAt: state.state.startedAt ?? null,
    lastTickAt: state.state.lastTickAt ?? null,
  } : { running: null, pid: null, startedAt: null, lastTickAt: null } });
  const readable = state.ok && daemon.sourceQuality?.complete === true;
  return {
    schemaVersion: 1,
    snapshotKind: 'local-persisted',
    authority: 'none',
    generatedAt: new Date().toISOString(),
    daemon: {
      running: liveness.alive,
      liveness: liveness.state,
      recordedRunning: state.ok ? state.state.running : null,
      pid: liveness.pid,
      startedAt: readable ? daemon.startedAt : null,
      lastTickAt: readable ? daemon.lastTickAt : null,
      sourceQuality: daemon.sourceQuality,
      activity: daemon.activity ?? null,
      tickProgress: daemon.tickProgress ?? null,
      itemsProcessed: readable && state.ok ? state.state.itemsProcessed : null,
    },
    pause: { state: pause.state, sourceState: pause.sourceState, reason: pause.reason },
    killSwitch: { state: kill.state, sourceState: kill.sourceState, reason: kill.reason },
    budget: fleetBudget(cfg, state),
    // Never forward raw ticks: they can carry dispatch traces or future fields.
    recentTicks: readable ? recentTicks.slice(-limit).map(tick => ({
      ts: tick.ts,
      durationMs: nonnegativeNumber(tick.durationMs),
      itemsConsidered: nonnegativeNumber(tick.itemsConsidered),
      proposalsCreated: nonnegativeNumber(tick.proposalsCreated),
      spentUsd: nonnegativeNumber(tick.spentUsd),
      reason: typeof tick.reason === 'string' ? tick.reason : null,
      dryRun: typeof tick.dryRun === 'boolean' ? tick.dryRun : null,
      backends: tickBackendCounts(tick.backends),
    })) : null,
    historyLimit: limit,
    historyTruncated: readable ? recentTicks.length > limit : null,
  };
}

/** Compact fleet inventory, with unavailable sources distinct from empty ones. */
export async function readFleetStatus() {
  const loop = await readFleetLoop(1);
  const cfg = loadConfigReadOnlyStrict();
  const backends = cfg.foundry?.allowedBackends ?? ['builtin'] as const;
  // Config merging is not runtime validation of every nested field. Never
  // reflect an arbitrary object from configuration as a backend identifier.
  if (!Array.isArray(backends) || backends.some(backend =>
    typeof backend !== 'string' || !Object.hasOwn(BUILTIN_ENGINE_REGISTRY, backend),
  )) throw new Error('Invalid configured fleet backends.');
  const backlog = loadBacklog();
  const { proposals, ...sourceQuality } = listProposalsDetailed({
    maxFiles: 2_000,
    maxBytes: 16 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
    requireComplete: true,
  });
  return {
    schemaVersion: 1,
    snapshotKind: loop.snapshotKind,
    authority: loop.authority,
    generatedAt: loop.generatedAt,
    daemon: loop.daemon,
    pause: loop.pause,
    killSwitch: loop.killSwitch,
    budget: loop.budget,
    backends: [...new Set(backends)].map(backend => ({
      backend,
      quota: evalFleetQuotaAuthority(backend, cfg),
      sourceQuality: inspectFleetQuotaAuthority(backend, cfg),
    })),
    queue: {
      sourceState: backlog ? 'available' : 'unavailable',
      generatedAt: backlog?.generatedAt ?? null,
      // This is cached inventory, never a claim of current dispatch eligibility.
      backlogItems: backlog?.items.length ?? null,
      repos: backlog?.repos.length ?? null,
    },
    proposals: {
      sourceQuality,
      pending: sourceQuality.complete ? proposals.filter(p => p.status === 'pending').length : null,
      awaitingHostMerge: sourceQuality.complete ? proposals.filter(p => p.status === 'awaiting-host-merge').length : null,
      applied: sourceQuality.complete ? proposals.filter(p => p.status === 'applied').length : null,
    },
  };
}

/**
 * `fleet_bus_hops` arguments. `from`/`to`/`excludeFrom` are routing-label refs
 * resolved through the server-owned identity registry — the same
 * `agentRefAddressMatcher` rule `fleet_bus_inbox`'s address filters apply, so
 * a ref naming one registered identity matches every label that identity
 * answers to and an unresolvable ref or unreadable registry keeps
 * exact-label matching. `id` keeps only the hop whose message id is strictly
 * equal. The hop log carries no timestamps, so there is deliberately no
 * `since`/`before`: position in the append order is the only ordering the
 * store proves.
 */
export interface FleetBusHopsArgs {
  /** Newest matching hops to return, oldest first; `matched` keeps the filtered count in the scanned window. */
  limit?: number;
  /** Sender ref — handle, `agent:<handle>`, stable id or alias — matched against every label of the resolved identity. */
  from?: string;
  /** Recipient ref under the same identity-label rule as `from`. */
  to?: string;
  /** Sender ref to drop under the same identity-label rule, inverted — it composes with `from` so a sender both included and excluded matches nothing. */
  excludeFrom?: string;
  /** Keep only the hop whose message id is strictly equal to this value — never a substring. */
  id?: string;
}

const BUS_HOPS_KEYS = new Set(['limit', 'from', 'to', 'excludeFrom', 'id']);

/**
 * Routing labels use the bus wire contract: printable ASCII tokens of 1..128
 * characters — the same dummy-envelope check `fleet_bus_inbox`'s address
 * filters apply. A label that could never appear on the bus is an argument
 * error, not an empty match.
 */
function hopsAddressLabel(value: unknown): value is string {
  return typeof value === 'string' && validateBusEnvelope({
    id: value, from: value, to: value, priority: 'P3', ttl: 1, body: null,
  }).ok;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys,
 * non-integer or out-of-range limits and malformed labels are all refused
 * before the hop log is touched.
 */
export function parseFleetBusHopsArgs(args: Record<string, unknown>): FleetBusHopsArgs | null {
  if (Object.keys(args).some(key => !BUS_HOPS_KEYS.has(key))) return null;
  const limit = args.limit === undefined ? 20 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_BUS_HOPS) return null;
  const parsed: FleetBusHopsArgs = { limit };
  for (const key of ['from', 'to', 'excludeFrom', 'id'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!hopsAddressLabel(value)) return null;
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Newest validated cross-agent bus hops (append order) from the private hop
 * log — the only source. A hop is a recorded send attempt: it carries message
 * id, from/to and nullable token usage, never a body, delivery, or lifecycle
 * claim. Missing and unreadable are distinct; neither yields invented rows.
 * Usage totals are subtotals of the returned tail's recorded attempts, not
 * provider usage or proof of delivery; unknown samples remain separate.
 *
 * The read scans the bounded tail window once (`BUS_HOPLOG_TAIL_MAX_ROWS`),
 * then applies the optional `from`/`to`/`excludeFrom`/`id` filters and returns
 * the newest `limit` matches oldest-first. `matched` counts the filter hits
 * inside that scanned window — a lower bound when `truncated` reports rows
 * beyond it, never a fleet-wide total the bounded read cannot prove.
 */
export async function readFleetBusHops(input: FleetBusHopsArgs = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_BUS_HOPS) {
    throw new RangeError('Bus hop limit must be an integer between 1 and 50.');
  }
  const tail = readBusHoplogTail(BUS_HOPLOG_TAIL_MAX_ROWS);
  const meta = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    sourceState: tail.state, logBytes: tail.logBytes, limit,
  };
  if (tail.state !== 'ok' || tail.hops === null) {
    return {
      ...meta, hops: null, matched: null, usageSummary: null,
      returnedHops: null, skippedRows: null, truncated: null,
    };
  }
  const registryRead = input.from === undefined && input.to === undefined && input.excludeFrom === undefined
    ? undefined : readAgentRegistry();
  const registry = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const from = input.from === undefined ? undefined : agentRefAddressMatcher(input.from, registry);
  const to = input.to === undefined ? undefined : agentRefAddressMatcher(input.to, registry);
  const excludeFrom = input.excludeFrom === undefined ? undefined : agentRefAddressMatcher(input.excludeFrom, registry);
  const matchedHops = tail.hops.filter(hop =>
    (from === undefined || from(hop.from)) &&
    (to === undefined || to(hop.to)) &&
    (excludeFrom === undefined || !excludeFrom(hop.from)) &&
    (input.id === undefined || hop.id === input.id));
  const page = matchedHops.slice(-limit);
  const hops = page.map(hop => ({
    id: hop.id, from: hop.from, to: hop.to,
    inputTokens: hop.inputTokens, outputTokens: hop.outputTokens,
  }));
  return {
    ...meta, sourceState: 'ok' as const, hops, matched: matchedHops.length,
    usageSummary: summarizeBusHops(hops), returnedHops: hops.length,
    skippedRows: tail.skippedRows,
    truncated: (tail.truncated ?? false) || matchedHops.length > hops.length,
  };
}
