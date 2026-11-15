/** Fleet status: readiness. Internal to status.ts. */

import type {
  PhantomAgentReportRollup,
} from '../types.js';
import type {
  FleetReadinessSourceHealth,
  FleetNextAction,
  FleetAutonomousShipReadinessBlocker,
  FleetStatus,
  AutonomousShipReadinessInputs,
  FleetReadinessSourceStatus,
  FleetReadinessSourceQualityBadge,
  FleetReadinessEvidenceEligibility,
  FleetAutonomousShipReadinessStatus,
  FleetAutonomousShipReadinessConfidence,
  FleetAutonomousShipReadinessVerdict,
} from './status-types.js';
import {
  phantomAuditSignalSummary,
  countPhrase,
} from './status-phantom.js';
import {
  readinessSource,
  READINESS_STATUS_STALE_MS,
  READINESS_DAEMON_STALE_MS,
  READINESS_QUEUE_STALE_MS,
  readinessPriorityRank,
  learningEvidenceReadinessSources,
} from './status-readiness-signals.js';
import {
  proposalOnceActivationEligible,
  residentStandingActivationAuthorized,
} from './status-sources.js';
import {
  remoteProtectionAuthorityReady,
  READINESS_REMOTE_PROTECTION_STALE_MS,
} from './status-automerge.js';

function phantomAuditReadinessSource(
  report: PhantomAgentReportRollup,
  generatedAt: string,
): FleetReadinessSourceHealth {
  const summary = phantomAuditSignalSummary(report);
  if (summary) {
    return readinessSource(
      'phantom',
      'Phantom Audit',
      'blocked',
      generatedAt,
      READINESS_STATUS_STALE_MS,
      summary.detail,
      { sourcePresent: true, sourceDegraded: true },
    );
  }

  const scope = report.scannedRepos > 0 ? ` across ${countPhrase(report.scannedRepos, 'scanned repo')}` : '';
  return readinessSource(
    'phantom',
    'Phantom Audit',
    'healthy',
    generatedAt,
    READINESS_STATUS_STALE_MS,
    `Phantom audit rollup is clear${scope}. Values hidden; only aggregate counts are shown.`,
    {
      empty: report.scannedRepos === 0 && report.validReports === 0 && report.failedReports === 0,
      sourcePresent: true,
    },
  );
}

function readinessBlocker(
  id: string,
  label: string,
  detail: string,
  severity: FleetNextAction['priority'],
  source: FleetAutonomousShipReadinessBlocker['source'],
): FleetAutonomousShipReadinessBlocker {
  return { id, label, detail, severity, source };
}

function resourceReadinessSource(status: FleetStatus, generatedAt: string): FleetReadinessSourceHealth {
  const backends = Array.isArray(status.backends) ? status.backends : [];
  if (backends.length === 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'unavailable',
      null,
      READINESS_STATUS_STALE_MS,
      'no allowed backends are visible in fleet status',
      { empty: true, sourcePresent: false },
    );
  }

  const unavailable = new Set(['exhausted', 'throttled', 'unreachable']);
  const resources = backends.map((backend) => backend.resource).filter(Boolean);
  const hardBlocked = backends.filter((backend) => unavailable.has(String(backend.resource?.availability ?? 'unknown')));
  const notSensed = backends.filter((backend) => backend.resource?.availability === 'not-sensed');
  const unknown = backends.filter((backend) => backend.resource?.availability === 'unknown' || !backend.resource);
  const openish = backends.filter((backend) =>
    backend.resource?.availability === 'open' || backend.resource?.availability === 'near',
  );
  const latestObservedAt = resources
    .map((resource) => resource?.snapshotAt ?? null)
    .filter((ts): ts is string => typeof ts === 'string')
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? generatedAt;

  if (hardBlocked.length === backends.length) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'blocked',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `all ${backends.length} backend resource signal(s) are constrained`,
      { sourcePresent: true },
    );
  }
  if (hardBlocked.length > 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'degraded',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `${hardBlocked.length}/${backends.length} backend resource signal(s) are constrained`,
      { sourcePresent: true, sourceDegraded: true },
    );
  }
  if (openish.length === 0 && (notSensed.length > 0 || unknown.length > 0)) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'unknown',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      'backend capacity exists but no sensed open resource signal is available',
      { sourcePresent: true },
    );
  }
  if (notSensed.length > 0 || unknown.length > 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'degraded',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `${notSensed.length + unknown.length}/${backends.length} backend resource signal(s) are unsensed or unknown`,
      { sourcePresent: true, sourceDegraded: true },
    );
  }
  return readinessSource(
    'resources',
    'Resource Signals',
    'healthy',
    latestObservedAt,
    READINESS_STATUS_STALE_MS,
    `${openish.length}/${backends.length} backend resource signal(s) are open or near capacity`,
    { sourcePresent: true },
  );
}

function shipReadinessSources(
  status: FleetStatus,
  inputs: AutonomousShipReadinessInputs,
): FleetReadinessSourceHealth[] {
  const daemonObservedAt = status.daemon.lockHeartbeatAt ?? status.daemon.lastTickAt;
  const daemonSourceDegraded = status.daemon.sourceQuality?.sourceState !== 'healthy';
  const daemonDetail = daemonSourceDegraded
    ? `daemon state source is degraded (${status.daemon.sourceQuality?.reason ?? 'unavailable'})`
    : status.daemon.running
    ? `daemon running; last tick ${status.daemon.lastTickAt ?? 'unknown'}`
    : proposalOnceActivationEligible(status)
      ? 'daemon is stopped; one exact proposal activation is snapshot-eligible'
      : residentStandingActivationAuthorized(status)
        ? 'daemon is stopped; resident-standing activation is snapshot-authorized'
      : `daemon is stopped; activation blocked (${status.daemon.activation?.reason ?? 'activation-readiness-unavailable'})`;
  const daemonSource = readinessSource(
    'daemon',
    'Daemon',
    daemonSourceDegraded ? 'unknown' : status.daemon.running ? 'healthy' : 'blocked',
    daemonObservedAt,
    READINESS_DAEMON_STALE_MS,
    daemonDetail,
  );

  const guardHealth = status.guardHealth;
  const guardSource = guardHealth
    ? readinessSource(
        'guard',
        'Guard Health',
        guardHealth.sourceQuality?.sourceState !== 'healthy'
          ? 'degraded'
          : guardHealth.blocks.length > 0
            ? 'blocked'
            : 'healthy',
        guardHealth.generatedAt,
        READINESS_STATUS_STALE_MS,
      guardHealth.sourceQuality?.sourceState !== 'healthy'
        ? `guard health source is degraded (${guardHealth.sourceQuality?.reasons.join(', ') || 'incomplete'})`
        : guardHealth.blocks.length > 0
        ? guardHealth.blocks[0]?.detail ?? 'guard health is blocking autonomous work'
        : 'guard health is clear',
      {
        empty: guardHealth.blocks.length === 0,
        sourcePresent: true,
        sourceDegraded: guardHealth.sourceQuality?.sourceState !== 'healthy',
      },
      )
    : readinessSource(
        'guard',
        'Guard Health',
        'unknown',
        null,
        READINESS_STATUS_STALE_MS,
        'guard health diagnosis is unavailable',
        { sourcePresent: false },
      );

  const readiness = status.autoMergeReadiness;
  const autoMergeSource = readiness
    ? readinessSource(
        'auto-merge',
        'Auto-Merge Gate',
        readiness.enabled && readiness.configurationBlocker === undefined
          ? (readiness.authorityBlocked ?? 0) === 0 && remoteProtectionAuthorityReady(readiness)
            ? 'healthy'
            : (readiness.branchAuthorityReady ?? 0) > 0
              ? 'degraded'
              : 'blocked'
          : 'blocked',
        readiness.remoteProtection?.required
          ? readiness.remoteProtection.observedAt
          : inputs.generatedAt,
        readiness.remoteProtection?.required
          ? READINESS_REMOTE_PROTECTION_STALE_MS
          : READINESS_STATUS_STALE_MS,
        readiness.enabled
          ? `${readiness.authorityReady ?? 0} authority-ready, ${readiness.preflightReady} preflight-ready, ${readiness.needsVerification} need verification, ${readiness.blocked} statically blocked; ${readiness.remoteProtection?.detail ?? 'remote protection status unavailable'}`
          : 'auto-merge is disabled',
        {
          empty:
            readiness.pending === 0 &&
            readiness.preflightReady === 0 &&
            readiness.needsVerification === 0 &&
            readiness.blocked === 0 &&
            readiness.knownVerificationFailed === 0 &&
            readiness.remoteProtection?.required !== true,
          sourcePresent: true,
        },
      )
    : readinessSource(
        'auto-merge',
        'Auto-Merge Gate',
        'unavailable',
        null,
        READINESS_STATUS_STALE_MS,
        status.proposals.authority?.detail ?? 'auto-merge readiness source is unavailable',
        { sourcePresent: false },
      );

  const queueSource = readinessSource(
    'queue',
    'Queue Snapshot',
    inputs.queueSourceStatus,
    inputs.queueSnapshotAt,
    READINESS_QUEUE_STALE_MS,
    inputs.queueSourceDetail,
    {
      empty: status.queue.backlogItems === 0,
      sourcePresent: inputs.queueSourceStatus !== 'unavailable' && inputs.queueSourceStatus !== 'unknown',
      sourceDegraded: inputs.queueSourceStatus === 'degraded',
    },
  );

  const laneLocks = status.laneLocks;
  const laneQuality = laneLocks?.sourceQuality;
  const laneSource = laneLocks
    ? readinessSource(
        'lane-locks',
        'Autonomy Lanes',
        laneLocks.unverifiedApplied > 0
          ? 'blocked'
          : laneQuality?.sourceState === 'healthy' && laneQuality.complete
            ? 'healthy'
            : laneQuality?.sourceState === 'degraded'
              ? 'degraded'
              : 'unavailable',
        laneLocks.generatedAt,
        READINESS_STATUS_STALE_MS,
        laneLocks.unverifiedApplied > 0
          ? `${laneLocks.unverifiedApplied} applied proposal(s) lack verification`
          : laneQuality?.sourceState === 'healthy' && laneQuality.complete
            ? `${laneLocks.active} active lane(s); no unverified applied work`
            : `autonomy lane evidence is incomplete (${laneQuality?.reasons.join(', ') || 'source unavailable'})`,
        {
          empty: laneLocks.active === 0 && laneLocks.awaitingHostMerge === 0 && laneLocks.unverifiedApplied === 0,
          sourcePresent: laneQuality !== undefined && laneQuality.sourceState !== 'missing',
          sourceDegraded: laneQuality?.sourceState !== 'healthy' || laneQuality.complete !== true,
        },
      )
    : readinessSource(
        'lane-locks',
        'Autonomy Lanes',
        'unavailable',
        null,
        READINESS_STATUS_STALE_MS,
        'autonomy lane evidence is unavailable',
        { sourcePresent: false },
      );

  const resourcesSource = resourceReadinessSource(status, inputs.generatedAt);

  const direction = status.autonomyDirection;
  const directionSource = direction
    ? readinessSource(
        'direction',
        'Autonomy Direction',
        'healthy',
        direction.generatedAt,
        READINESS_STATUS_STALE_MS,
        `${direction.mode} recommendation with ${direction.confidence} confidence`,
        { sourcePresent: true },
      )
    : readinessSource(
        'direction',
        'Autonomy Direction',
        'unknown',
        null,
        READINESS_STATUS_STALE_MS,
        'autonomy direction summary is unavailable',
        { sourcePresent: false },
      );

  const phantomSource = status.phantom?.agentReport
    ? phantomAuditReadinessSource(status.phantom.agentReport, inputs.generatedAt)
    : null;

  return [
    daemonSource,
    guardSource,
    autoMergeSource,
    queueSource,
    laneSource,
    resourcesSource,
    directionSource,
    ...(phantomSource ? [phantomSource] : []),
  ];
}

function readinessSourceSummary(sources: FleetReadinessSourceHealth[]): Record<FleetReadinessSourceStatus, number> {
  const summary: Record<FleetReadinessSourceStatus, number> = {
    healthy: 0,
    degraded: 0,
    blocked: 0,
    unavailable: 0,
    unknown: 0,
  };
  for (const source of sources) summary[source.status]++;
  return summary;
}

function readinessSourceQualitySummary(
  sources: FleetReadinessSourceHealth[],
): Record<FleetReadinessSourceQualityBadge, number> {
  const summary: Record<FleetReadinessSourceQualityBadge, number> = {
    'healthy-source': 0,
    'healthy-zero': 0,
    'degraded-source': 0,
    'missing-source': 0,
    'stale-source': 0,
    'unknown-source': 0,
  };
  for (const source of sources) {
    const badge = source.sourceQuality?.badge ?? 'unknown-source';
    summary[badge]++;
  }
  return summary;
}

function readinessEvidenceSummary(
  sources: FleetReadinessSourceHealth[],
): Record<FleetReadinessEvidenceEligibility, number> {
  const summary: Record<FleetReadinessEvidenceEligibility, number> = {
    eligible: 0,
    'cold-start': 0,
    withheld: 0,
    observational: 0,
    'not-applicable': 0,
  };
  for (const source of sources) {
    if (source.category === 'evidence' && source.eligibility) summary[source.eligibility]++;
  }
  return summary;
}

function readinessFreshnessSummary(
  generatedAt: string,
  sources: FleetReadinessSourceHealth[],
): FleetAutonomousShipReadinessStatus['freshness'] {
  const observed = sources
    .map((source) => source.observedAt)
    .filter((ts): ts is string => typeof ts === 'string' && Number.isFinite(Date.parse(ts)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const ageValues = sources
    .map((source) => source.ageMs)
    .filter((age): age is number => typeof age === 'number' && Number.isFinite(age));
  const staleSources = sources.filter((source) => source.freshness === 'stale').length;
  const unknownSources = sources.filter((source) => source.freshness === 'unknown').length;
  return {
    generatedAt,
    overall: staleSources > 0 ? 'stale' : unknownSources > 0 ? 'unknown' : 'fresh',
    freshestAt: observed.length > 0 ? observed[observed.length - 1]! : null,
    stalestAt: observed.length > 0 ? observed[0]! : null,
    maxAgeMs: ageValues.length > 0 ? Math.max(...ageValues) : null,
    staleSources,
    unknownSources,
  };
}

function chooseReadinessBlocker(
  status: FleetStatus,
  sources: FleetReadinessSourceHealth[],
): FleetAutonomousShipReadinessBlocker | null {
  const enrollmentRegistry = status.queue.repos?.registry;
  if (enrollmentRegistry?.state === 'degraded') {
    return readinessBlocker(
      'enrollment-registry-degraded',
      'Enrollment registry degraded',
      `Enrollment authority could not be proven (${enrollmentRegistry.reason}); queue inventory and autonomous work are withheld.`,
      'high',
      'queue',
    );
  }
  if (status.killSwitch?.state === 'unknown') {
    return readinessBlocker(
      'kill-switch-source-unknown',
      'Kill switch source unknown',
      'The global kill switch cannot be inspected, so autonomous shipping remains paused.',
      'critical',
      'fleet',
    );
  }
  if (status.killed) {
    return readinessBlocker(
      'kill-switch',
      'Fleet paused',
      'The global kill switch is engaged, so autonomous shipping is paused.',
      'critical',
      'fleet',
    );
  }
  if (status.daemon.sourceQuality?.sourceState !== 'healthy') {
    return readinessBlocker(
      'daemon-source-degraded',
      'Daemon state source degraded',
      `Daemon state is ${status.daemon.sourceQuality?.reason ?? 'unavailable'}; ` +
        'running state and spend cannot be trusted.',
      'critical',
      'daemon',
    );
  }
  if (!status.daemon.running) {
    if (!proposalOnceActivationEligible(status) && !residentStandingActivationAuthorized(status)) {
      return readinessBlocker(
        'daemon-activation-blocked',
        'Daemon activation blocked',
        `The daemon is stopped and no exact one-shot proposal activation is currently eligible ` +
          `(${status.daemon.activation?.reason ?? 'activation-readiness-unavailable'}).`,
        'critical',
        'daemon',
      );
    }
    return readinessBlocker(
      'daemon-stopped',
      'Daemon stopped',
      proposalOnceActivationEligible(status)
        ? 'The daemon is stopped; an exact one-shot proposal activation is eligible but must be revalidated at execution.'
        : 'The daemon is stopped; resident-standing activation is authorized but must be revalidated at execution.',
      'critical',
      'daemon',
    );
  }
  const guardBlock = status.guardHealth?.blocks?.[0];
  if (status.guardHealth?.sourceQuality?.sourceState !== 'healthy') {
    return readinessBlocker(
      'guard-source-degraded',
      'Guard health source degraded',
      'Guard health is incomplete, so autonomous shipping remains paused.',
      'critical',
      'guard',
    );
  }
  if (guardBlock) {
    return readinessBlocker('guard-block', 'Guard block', guardBlock.detail, 'critical', 'guard');
  }
  if (status.proposals.pending > 0 && status.autonomy?.authorityState === 'degraded') {
    const quality = status.autonomy.sourceQuality;
    return readinessBlocker(
      'signed-evidence-degraded',
      'Signed evidence authority degraded',
      `The signed evidence store is incomplete (${quality.invalidFiles} invalid, ` +
        `${quality.unreadableFiles} unreadable${quality.limitExceeded ? ', bounded read limit exceeded' : ''}); ` +
        `${status.proposals.pending} pending proposal(s) remain fail-closed.`,
      'high',
      'autonomy-packs',
    );
  }
  const sharedQueue = status.queue.shared;
  if (sharedQueue && !sharedQueue.authorityReady) {
    const detail = !sharedQueue.trustedCoherentStorage
      ? 'Filesystem queue authority requires trustedCoherentStorage:true after the operator verifies one coherent cross-host mount.'
      : !sharedQueue.capability.verified
        ? `Local filesystem primitive probe failed at ${sharedQueue.capability.failure ?? 'an unknown step'}.`
        : 'The shared queue is configured but its authority source is unavailable.';
    return readinessBlocker(
      'shared-queue-authority-unavailable',
      'Shared queue authority unavailable',
      detail,
      'high',
      'queue',
    );
  }
  const readiness = status.autoMergeReadiness;
  if (!readiness) {
    return readinessBlocker(
      'auto-merge-readiness-unavailable',
      'Auto-merge status unavailable',
      status.proposals.authority?.detail ?? 'The auto-merge readiness source could not be read.',
      'high',
      'auto-merge',
    );
  }
  if (!readiness.enabled) {
    return readinessBlocker(
      'auto-merge-disabled',
      'Auto-merge disabled',
      'Autonomous shipping cannot drain proposals while auto-merge is disabled.',
      'high',
      'auto-merge',
    );
  }
  if (readiness.configurationBlocker) {
    return readinessBlocker(
      'auto-merge-configuration-invalid',
      'Auto-merge configuration invalid',
      readiness.configurationBlocker,
      'high',
      'auto-merge',
    );
  }
  if (
    readiness.remoteProtection &&
    !remoteProtectionAuthorityReady(readiness) &&
    (readiness.branchAuthorityReady ?? 0) === 0
  ) {
    return readinessBlocker(
      'protected-remote-unavailable',
      'Protected remote authority unavailable',
      readiness.remoteProtection.detail,
      'high',
      'auto-merge',
    );
  }
  if ((status.proposals.awaitingHostMerge ?? 0) > 0) {
    return readinessBlocker(
      'host-handoff',
      'Host PR handoff',
      `${status.proposals.awaitingHostMerge} proposal(s) are waiting for host merge reconciliation.`,
      'high',
      'auto-merge',
    );
  }
  if ((status.laneLocks?.unverifiedApplied ?? 0) > 0) {
    return readinessBlocker(
      'unverified-applied-work',
      'Applied work lacks verification',
      `${status.laneLocks!.unverifiedApplied} applied proposal(s) are recent or goal-linked but lack verification.`,
      'high',
      'lane-locks',
    );
  }
  const phantomAudit = phantomAuditSignalSummary(status.phantom?.agentReport);
  if (phantomAudit) {
    return readinessBlocker(
      'phantom-audit-risk',
      'Phantom audit needs review',
      phantomAudit.detail,
      'high',
      'phantom',
    );
  }
  if ((readiness.authorityReady ?? 0) > 0) {
    return null;
  }
  if ((readiness.authorityBlocked ?? 0) > 0) {
    const topReason = Object.entries(readiness.authorityByReason ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return readinessBlocker(
      'merge-authority-incomplete',
      'Merge authority incomplete',
      topReason
        ? `${topReason[1]}x ${topReason[0]}`
        : `${readiness.authorityBlocked} proposal(s) lack complete authority evidence.`,
      'high',
      'auto-merge',
    );
  }
  if (readiness.needsVerification > 0) {
    return readinessBlocker(
      'verification-needed',
      'Verification needed',
      `${readiness.needsVerification} proposal(s) need verification before autonomous ship can proceed.`,
      'high',
      'auto-merge',
    );
  }
  if (readiness.knownVerificationFailed > 0) {
    return readinessBlocker(
      'verification-failed',
      'Verification failed',
      `${readiness.knownVerificationFailed} proposal(s) have known verification failures.`,
      'medium',
      'auto-merge',
    );
  }
  if (readiness.blocked > 0) {
    const topReason = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return readinessBlocker(
      'merge-gate-blocked',
      'Merge gate blocked',
      topReason ? `${topReason[1]}x ${topReason[0]}` : `${readiness.blocked} proposal(s) are blocked.`,
      'medium',
      'auto-merge',
    );
  }
  const queueSource = sources.find((source) => source.id === 'queue');
  if (
    status.queue.backlogItems === 0 &&
    status.proposals.pending === 0 &&
    queueSource &&
    (queueSource.status === 'unknown' || queueSource.status === 'unavailable')
  ) {
    return readinessBlocker(
      'queue-source-unavailable',
      'Queue source unavailable',
      queueSource.detail,
      'medium',
      'queue',
    );
  }
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (status.queue.backlogItems > 0 && eligibleBacklogItems === 0 && status.proposals.pending === 0) {
    const routeBlocked = status.queue.repairRouteBlockedItems ?? 0;
    if (routeBlocked > 0) {
      const topReason = status.queue.generatedRepairRoutes?.byReason.find((entry) => entry.reason !== 'feasible');
      return readinessBlocker(
        'repair-route-unavailable',
        'Repair routes unavailable',
        `${routeBlocked} generated repair item(s) remain queued but cannot be claimed` +
          `${topReason ? `; top reason: ${topReason.reason} (${topReason.count})` : ''}.`,
        'medium',
        'queue',
      );
    }
    const repairBlocked = status.queue.repairControlBlockedItems ?? 0;
    if (repairBlocked > 0) {
      const unavailable = status.queue.repairLifecycleUnavailableItems ?? 0;
      const terminal = status.queue.repairTerminalItems ?? 0;
      const quarantined = status.queue.repairQuarantinedItems ?? 0;
      return readinessBlocker(
        'repair-lifecycle-control-blocked',
        'Repair lifecycle control blocked',
        `${repairBlocked} generated repair item(s) are withheld ` +
          `(${unavailable} lifecycle unavailable, ${terminal} terminal, ${quarantined} quarantined).`,
        'medium',
        'queue',
      );
    }
    const cooling = status.queue.cooldownItems ?? 0;
    const pending = status.queue.pendingItems ?? 0;
    const nextEligible = status.queue.nextEligibleAt ? ` Next eligible at ${status.queue.nextEligibleAt}.` : '';
    return readinessBlocker(
      'backlog-cooldown-gated',
      'Backlog cooling',
      `Backlog exists, but no items are currently daemon-eligible (${cooling} cooling, ${pending} already covered by pending proposals).${nextEligible}`,
      'medium',
      'queue',
    );
  }
  const resourceSource = sources.find((source) => source.id === 'resources');
  if (resourceSource?.status === 'blocked' || resourceSource?.status === 'unavailable') {
    return readinessBlocker(
      'resources-blocked',
      'Resources blocked',
      resourceSource.detail,
      'medium',
      'resources',
    );
  }
  if (eligibleBacklogItems > 0 && status.proposals.pending === 0) {
    return readinessBlocker(
      'proposal-production-needed',
      'Proposal production needed',
      'Backlog work is visible, but there are no pending proposals ready to ship.',
      'medium',
      'queue',
    );
  }
  return null;
}

function readinessConfidence(summary: Record<FleetReadinessSourceStatus, number>): FleetAutonomousShipReadinessConfidence {
  if (summary.unavailable > 0 || summary.unknown > 0) return 'low';
  if (summary.degraded > 0) return 'medium';
  return 'high';
}

function readinessVerdict(
  status: FleetStatus,
  summary: Record<FleetReadinessSourceStatus, number>,
  topBlocker: FleetAutonomousShipReadinessBlocker | null,
): FleetAutonomousShipReadinessVerdict {
  if (topBlocker && readinessPriorityRank(topBlocker.severity) <= readinessPriorityRank('high')) {
    return 'blocked';
  }
  if ((status.autoMergeReadiness?.authorityReady ?? 0) > 0) {
    return summary.degraded > 0 || summary.unavailable > 0 || summary.unknown > 0 ? 'degraded' : 'ready';
  }
  if (
    status.queue.backlogItems === 0 &&
    status.proposals.pending === 0 &&
    (status.proposals.awaitingHostMerge ?? 0) === 0
  ) {
    return summary.degraded > 0 || summary.unavailable > 0 || summary.unknown > 0 ? 'unknown' : 'idle';
  }
  return 'degraded';
}

export function buildAutonomousShipReadiness(
  status: FleetStatus,
  inputs: AutonomousShipReadinessInputs,
): FleetAutonomousShipReadinessStatus {
  const sources = shipReadinessSources(status, inputs);
  const sourceSummary = readinessSourceSummary(sources);
  const sourceQualitySummary = readinessSourceQualitySummary(sources);
  const evidenceSources = learningEvidenceReadinessSources(status, inputs.generatedAt);
  const evidenceSummary = readinessEvidenceSummary(evidenceSources);
  const requiredSources = evidenceSources.filter((source) => source.applicability === 'required');
  const evidenceState = evidenceSummary.withheld > 0 || requiredSources.some((source) => source.status === 'degraded')
    ? 'degraded'
    : evidenceSummary['cold-start'] > 0
      ? 'cold-start'
      : 'eligible';
  const topBlocker = chooseReadinessBlocker(status, sources);
  const nextActions = status.nextActions ?? [];
  const primaryAction =
    topBlocker?.id === 'phantom-audit-risk'
      ? nextActions.find((action) => action.id === 'review-phantom-audit') ?? nextActions[0] ?? null
      : topBlocker?.id === 'signed-evidence-degraded'
        ? nextActions.find((action) => action.id === 'inspect-signed-evidence') ?? nextActions[0] ?? null
      : topBlocker?.id === 'enrollment-registry-degraded'
        ? nextActions.find((action) => action.id === 'repair-enrollment-registry') ?? nextActions[0] ?? null
      : topBlocker?.id === 'auto-merge-disabled' && status.proposals.pending > 0
        ? nextActions.find((action) => action.id === 'inspect-pending-proposals') ?? nextActions[0] ?? null
      : nextActions[0] ?? null;
  return {
    verdict: readinessVerdict(status, sourceSummary, topBlocker),
    confidence: readinessConfidence(sourceSummary),
    freshness: readinessFreshnessSummary(inputs.generatedAt, sources),
    topBlocker,
    primaryAction,
    sources,
    sourceSummary,
    sourceQualitySummary,
    evidenceMatrix: {
      version: 1,
      state: evidenceState,
      sources: evidenceSources,
      summary: evidenceSummary,
    },
  };
}
