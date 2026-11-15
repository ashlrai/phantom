/** Fleet status: sources. Internal to status.ts. */

import type {
  AshlrConfig,
  EngineId,
  DaemonTick,
} from '../types.js';
import type {
  FleetAutonomyControlMode,
  FleetBackendResourceStatus,
  FleetBackendStatus,
  FleetDaemonStatusRead,
  FleetStatus,
  FleetDispatchManifestStatus,
  FleetAutonomyDirectionSummary,
  FleetAutonomyStatus,
  FleetSharedQueueStatus,
  FleetActiveWorkStatus,
} from './status-types.js';
import type {
  BackendResourceState,
} from '../fabric/resource-monitor.js';
import type {
  DispatchManifestSourceQuality,
} from './dispatch-manifest.js';
import type {
  EcosystemDoctorReport,
} from '../ecosystem/doctor.js';
import type {
  ResourceStrategyReport,
} from '../autonomy/resource-strategy.js';
import type {
  AutonomyEvidencePack,
  AutonomyEvidenceSourceQuality,
} from '../autonomy/evidence-pack.js';
import {
  hostname,
} from 'node:os';

/** Recent window for dispatch + merge counting: the last 24 hours. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Keep concurrently appended rows outside exact cross-source joins until settled. */
export const LEARNING_SNAPSHOT_SETTLE_MS = 2 * 60 * 1000;

function processExists(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function resolveAutonomyControlMode(cfg: AshlrConfig): FleetAutonomyControlMode {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  if (!foundry) return 'disabled';
  return foundry['autonomyControlLoop'] === false ? 'advisory' : 'executable';
}

function backendResourceStatus(
  state: BackendResourceState | undefined,
  fallbackReason = 'no resource sensor reported this allowed backend',
): FleetBackendResourceStatus {
  if (!state) {
    return {
      availability: 'not-sensed',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      reason: fallbackReason,
      snapshotAt: null,
    };
  }
  return {
    availability: state.availability,
    usedPct: state.usedPct,
    cap: state.cap,
    capUnit: state.capUnit,
    capWindow: state.capWindow,
    resetsAt: state.resetsAt,
    reason: state.reason,
    snapshotAt: state.snapshotAt,
  };
}

export async function attachBackendResources(backends: FleetBackendStatus[], cfg: AshlrConfig): Promise<void> {
  if (backends.length === 0) return;
  const byBackend = new Map<EngineId, BackendResourceState>();
  let fallbackReason = 'no resource sensor reported this allowed backend';
  try {
    const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
    const snapshot = await getResourceSnapshot(cfg);
    for (const state of snapshot.backends) byBackend.set(state.backend, state);
  } catch {
    fallbackReason = 'resource snapshot unavailable';
  }
  for (const backend of backends) {
    backend.resource = backendResourceStatus(byBackend.get(backend.backend), fallbackReason);
  }
}

/** Read daemon ledger, lock, and activity as one fail-closed observation. */
export async function readFleetDaemonStatus(): Promise<FleetDaemonStatusRead> {
  let daemon: FleetStatus['daemon'] = {
    running: false,
    sourceQuality: {
      sourceState: 'degraded',
      complete: false,
      reason: 'unavailable',
    },
    startedAt: null,
    lastTickAt: null,
    todaySpentUsd: 0,
  };
  let recentTicks: DaemonTick[] = [];
  try {
    const { loadDaemonStateStrict, readDaemonLockOwner } = await import('../daemon/state.js');
    const { readDaemonActivity } = await import('../daemon/activity.js');
    const daemonState = loadDaemonStateStrict();
    if (!daemonState.ok) {
      daemon.sourceQuality = {
        sourceState: 'degraded',
        complete: false,
        reason: daemonState.reason,
      };
      throw new Error(`daemon-state-${daemonState.reason}`);
    }
    const ds = daemonState.state;
    const startedAt = ds.startedAt ?? null;
    const lastTickAt = ds.lastTickAt ?? null;
    const lockOwner = readDaemonLockOwner();
    const lockHeartbeatAt = ds.running === true && lockOwner?.pid === ds.pid
      ? lockOwner.heartbeatAt
      : null;
    const activityRead = readDaemonActivity();
    const activity = activityRead.activity;
    const ownerMatches = ds.running === true && activity !== null && activity.pid === ds.pid &&
      activity.daemonStartedAt === startedAt;
    const activityHealthy = ownerMatches && activityRead.sourceState === 'healthy' &&
      activityRead.freshness === 'fresh' && activityRead.ownerState === 'alive';
    const lockOwnerAlive = processExists(lockOwner?.pid);
    const liveLockContradiction = lockOwnerAlive && (
      daemonState.fresh ||
      ds.running !== true ||
      lockOwner?.pid !== ds.pid
    );
    const stateConsistent =
      activityRead.sourceState !== 'degraded' &&
      !liveLockContradiction;
    const tickInProgress = activityHealthy && activity?.phase === 'tick';
    let tickProgress: FleetStatus['daemon']['tickProgress'] | null = null;
    if (ds.running === true && typeof ds.pid === 'number') {
      try {
        const { readTickProgress, describeTickProgress } = await import('../daemon/tick-progress.js');
        const read = readTickProgress({ expectPid: ds.pid });
        if (read) {
          tickProgress = {
            phase: read.progress.phase,
            detail: read.progress.detail,
            tickStartedAt: read.progress.tickStartedAt,
            phaseStartedAt: read.progress.phaseStartedAt,
            tickAgeMs: read.tickAgeMs,
            phaseAgeMs: read.phaseAgeMs,
            summary: describeTickProgress(read),
          };
        }
      } catch {
        tickProgress = null;
      }
    }
    const childActivity = activityHealthy && activity?.phase === 'post-tick' &&
      typeof activity.activeChildren === 'number' && activity.activeChildren > 0;
    daemon = {
      running: ds.running === true,
      sourceQuality: {
        sourceState: stateConsistent ? 'healthy' : 'degraded',
        complete: stateConsistent,
        reason: stateConsistent
          ? daemonState.fresh ? 'missing' : 'healthy'
          : 'inconsistent',
      },
      pid: ds.pid ?? null,
      startedAt,
      lastTickAt,
      ...(lockHeartbeatAt ? { lockHeartbeatAt } : {}),
      ...(tickInProgress ? { tickInProgress } : {}),
      ...(tickProgress ? { tickProgress } : {}),
      ...(childActivity ? { childActivity } : {}),
      activity: {
        source: 'daemon-activity',
        sourceState: activityRead.sourceState,
        freshness: activityRead.freshness,
        ownerState: activityRead.ownerState,
        phase: activity?.phase ?? null,
        phaseStartedAt: activityRead.phaseStartedAt,
        observedAt: activity?.observedAt ?? null,
        ageMs: activityRead.ageMs,
        activeChildren: activity?.activeChildren ?? null,
        ownerMatches,
      },
      todaySpentUsd: typeof ds.todaySpentUsd === 'number' ? ds.todaySpentUsd : 0,
    };
    recentTicks = Array.isArray(ds.ticks) ? ds.ticks : [];
  } catch {
    // leave fallback
  }
  return { daemon, recentTicks };
}

export async function buildDispatchManifestStatus(): Promise<{
  summary?: FleetDispatchManifestStatus;
  sourceQuality: DispatchManifestSourceQuality;
}> {
  const { readDispatchManifestEventsDetailed } = await import('./dispatch-manifest.js');
  const read = readDispatchManifestEventsDetailed({ limit: 1000 });
  const events = read.events;
  const sourceQuality: DispatchManifestSourceQuality = {
    sourceState: read.sourceState,
    sourcePresent: read.sourcePresent,
    complete: read.complete,
    stopReasons: read.stopReasons,
    filesRead: read.filesRead,
    bytesRead: read.bytesRead,
    rowsScanned: read.rowsScanned,
    invalidRows: read.invalidRows,
    unreadableFiles: read.unreadableFiles,
  };
  if (events.length === 0 || sourceQuality.sourceState !== 'healthy' || !sourceQuality.complete) {
    return { sourceQuality };
  }

  const byBackend = new Map<string, number>();
  let assigned = 0;
  let unassigned = 0;
  let latestAt: string | null = null;
  for (const event of events) {
    assigned += event.counts.assigned;
    unassigned += event.counts.unassigned;
    if (!latestAt || Date.parse(event.ts) > Date.parse(latestAt)) latestAt = event.ts;
    for (const [backend, count] of Object.entries(event.backendCounts)) {
      byBackend.set(backend, (byBackend.get(backend) ?? 0) + count);
    }
  }

  return { sourceQuality, summary: {
    events: events.length,
    latestAt,
    assigned,
    unassigned,
    byBackend: [...byBackend.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([backend, assignments]) => ({ backend, assignments })),
    recent: events.slice(0, 8).map((event) => ({
      manifestId: event.manifestId,
      ts: event.ts,
      assigned: event.counts.assigned,
      unassigned: event.counts.unassigned,
      backends: event.backendCounts,
      ...(event.resourceSnapshotAt ? { resourceSnapshotAt: event.resourceSnapshotAt } : {}),
    })),
  } };
}

export function proposalOnceActivationEligible(status: FleetStatus): boolean {
  const activation = status.daemon.activation;
  return activation?.requestedShape === 'proposal-once' && activation.commandEligible === true;
}

export function residentStandingActivationAuthorized(status: FleetStatus): boolean {
  return status.daemon.activation?.residentStandingAuthorized === true;
}

export function lightweightEcosystemReport(now: Date | undefined, root: string | undefined): EcosystemDoctorReport {
  return {
    generatedAt: (now ?? new Date()).toISOString(),
    root: root ?? process.cwd(),
    summary: { pass: 0, warn: 1, fail: 0, total: 1, repos: 0 },
    checks: [{
      id: 'ecosystem-doctor',
      label: 'Ecosystem doctor',
      status: 'warn',
      detail: 'skipped in fleet status summary; run `ashlr fleet direction` for full report',
    }],
    repos: [],
  };
}

export function buildAutonomyDirectionSummary(report: ResourceStrategyReport): FleetAutonomyDirectionSummary {
  return {
    generatedAt: report.generatedAt,
    mode: report.mode,
    confidence: report.confidence,
    reasons: report.reasons.slice(0, 3),
    recommendedActions: report.recommendedActions.slice(0, 3),
    resources: {
      posture: report.resources.posture,
      constrained: report.resources.constrained,
      depleted: report.resources.depleted,
    },
    guardHealth: {
      blocked: report.guardHealth.blocked,
      blocks: report.guardHealth.blocks.length,
    },
    budgets: {
      daemonBudgetLevel: report.budgets.daemonBudgetLevel,
      daemonSpentTodayUsd: report.budgets.daemonSpentTodayUsd,
    },
    productionVelocity: report.productionVelocity,
  };
}

export function buildAutonomyStatus(
  packs: AutonomyEvidencePack[],
  sourceQuality: AutonomyEvidenceSourceQuality,
): FleetAutonomyStatus {
  const byTier: Record<string, number> = {};
  let allowed = 0;
  let denied = 0;
  let latestAt: string | null = null;
  let sealedV3 = 0;

  for (const pack of packs) {
    if (pack.version === 3) sealedV3++;
    if (latestAt === null || Date.parse(pack.generatedAt) > Date.parse(latestAt)) {
      latestAt = pack.generatedAt;
    }
    const tier = pack.policy?.tier ?? 'unknown';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    if (pack.policy?.allowed === true) allowed++;
    else if (pack.policy?.allowed === false) denied++;
  }

  return {
    evidencePacks: packs.length,
    latestAt,
    allowed,
    denied,
    byTier,
    authorityState: sourceQuality.sourceState === 'missing'
      ? 'cold-start'
      : sourceQuality.sourceState === 'healthy' && sourceQuality.complete
        ? 'ready'
        : 'degraded',
    protocols: { sealedV3, legacy: packs.length - sealedV3 },
    sourceQuality: { ...sourceQuality },
    recent: packs.slice(0, 8).map((pack) => ({
      proposalId: pack.proposal.id,
      generatedAt: pack.generatedAt,
      title: pack.proposal.title,
      tier: pack.policy?.tier ?? null,
      action: pack.policy?.action ?? null,
      allowed: pack.policy?.allowed ?? null,
      target: pack.target,
      riskClass: pack.riskClass,
      verificationPassed: pack.verification.passed,
      changedFiles: pack.diff.files.length,
      changedLines: pack.diff.changedLines,
      reason: pack.policy?.reason ?? null,
    })),
  };
}

export async function buildSharedQueueStatus(cfg: AshlrConfig): Promise<FleetSharedQueueStatus | undefined> {
  const sq = cfg.fleet?.sharedQueue;
  if (sq?.mode !== 'filesystem' || !sq.path || sq.path.trim().length === 0) {
    return undefined;
  }

  const path = sq.path;
  const machineId = sq.machineId && sq.machineId.trim().length > 0 ? sq.machineId : hostname();
  const leaseMs =
    typeof sq.leaseMs === 'number' && Number.isFinite(sq.leaseMs) && sq.leaseMs > 0
      ? Math.floor(sq.leaseMs)
      : 5 * 60 * 1000;
  const cooldownMs = configCooldownMs(cfg);
  const trustedCoherentStorage = sq.trustedCoherentStorage === true;

  try {
    const { SharedStore } = await import('./shared-store.js');
    const store = new SharedStore(path, leaseMs);
    const health = store.readHealth({ machineId, ...(cooldownMs !== undefined ? { cooldownMs } : {}) });
    return {
      enabled: true,
      mode: 'filesystem',
      machineId,
      ...health,
      trustedCoherentStorage,
      authorityReady: trustedCoherentStorage && health.capability.verified && health.readable &&
        health.lock.recoveryRequired === false,
    };
  } catch {
    return {
      enabled: true,
      mode: 'filesystem',
      path,
      machineId,
      leaseMs,
      readable: false,
      capability: {
        scope: 'local-primitives-only',
        durabilityPolicy: process.platform === 'win32'
          ? 'windows-file-fsync-atomic-rename'
          : 'posix-file-and-directory-fsync',
        checked: false,
        verified: false,
        failure: 'status-unavailable',
      },
      trustedCoherentStorage,
      authorityReady: false,
      activeClaims: 0,
      ownedClaims: 0,
      expiredClaims: 0,
      reclaimableClaims: 0,
      executingClaims: 0,
      ambiguousClaims: 0,
      claimsByMachine: [],
      claimSamples: [],
      nextLeaseExpiryAt: null,
      oldestExpiredMs: null,
      workedEvents: 0,
      cooldownItems: 0,
      usageEntries: 0,
      lock: { present: false, ageMs: null, stale: false, links: null, recoveryRequired: false },
    };
  }
}

function compactStatusMetadata(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

export async function buildActiveWorkStatus(): Promise<FleetActiveWorkStatus | undefined> {
  try {
    const { readDaemonSpendGuard } = await import('../daemon/state.js');
    const result = readDaemonSpendGuard();
    if (!result.exists) return undefined;

    const guard = result.guard;
    const armedMs = guard?.armedAt ? Date.parse(guard.armedAt) : NaN;
    const ageMs = Number.isFinite(armedMs) ? Math.max(0, Date.now() - armedMs) : null;
    const itemIds = Array.isArray(guard?.itemIds)
      ? guard.itemIds
          .filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0)
          .map((itemId) => compactStatusMetadata(itemId))
      : [];

    return {
      source: 'daemon-spend-guard',
      path: result.path,
      exists: true,
      malformed: result.malformed,
      pid: typeof guard?.pid === 'number' ? guard.pid : null,
      hostname: typeof guard?.hostname === 'string' ? compactStatusMetadata(guard.hostname, 120) : null,
      armedAt: typeof guard?.armedAt === 'string' ? guard.armedAt : null,
      ageMs,
      itemCount: itemIds.length,
      itemIds: itemIds.slice(0, 12),
      ...(result.error ? { error: compactStatusMetadata(result.error, 240) } : {}),
    };
  } catch {
    return undefined;
  }
}

export function configCooldownMs(cfg: AshlrConfig): number | undefined {
  const daemon = (cfg as { daemon?: Record<string, unknown> }).daemon;
  const value = daemon?.['cooldownMs'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Sum `tick.backends[backend]` across recent ticks (within RECENT_WINDOW_MS).
 * Pure fallback for when the quota ledger is unavailable.
 */
export function sumRecentBackend(
  ticks: Array<{ ts?: string; backends?: Record<string, number> }>,
  backend: EngineId,
): number {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let sum = 0;
  for (const t of ticks) {
    const n = t.backends?.[backend];
    if (typeof n !== 'number' || n <= 0) continue;
    const ts = t.ts ? Date.parse(t.ts) : NaN;
    if (Number.isNaN(ts) || ts >= cutoff) sum += n;
  }
  return sum;
}
