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
import { readBusHoplogTail } from '../core/fleet/bus-hoplog.js';

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
 * Newest validated cross-agent bus hops (append order) from the private hop
 * log — the only source. A hop is a recorded send attempt: it carries message
 * id, from/to and nullable token usage, never a body, delivery, or lifecycle
 * claim. Missing and unreadable are distinct; neither yields invented rows.
 */
export async function readFleetBusHops(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_BUS_HOPS) {
    throw new RangeError('Bus hop limit must be an integer between 1 and 50.');
  }
  const tail = readBusHoplogTail(limit);
  return {
    schemaVersion: 1,
    snapshotKind: 'local-persisted',
    authority: 'none',
    generatedAt: new Date().toISOString(),
    sourceState: tail.state,
    logBytes: tail.logBytes,
    hops: tail.hops === null ? null : tail.hops.map(hop => ({
      id: hop.id,
      from: hop.from,
      to: hop.to,
      inputTokens: hop.inputTokens,
      outputTokens: hop.outputTokens,
    })),
    returnedHops: tail.hops === null ? null : tail.hops.length,
    skippedRows: tail.skippedRows,
    truncated: tail.truncated,
    limit,
  };
}
