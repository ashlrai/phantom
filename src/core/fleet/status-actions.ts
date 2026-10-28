/** Fleet status: actions. Internal to status.ts. */

import type {
  FleetStatus,
  FleetAutonomyEffectivenessStatus,
  FleetNextAction,
  FleetMissionBrief,
  FleetAutonomousShipReadinessBlocker,
  FleetNextActionCommandSafety,
  FleetNextActionCommand,
} from './status-types.js';
import {
  proposalOnceActivationEligible,
  residentStandingActivationAuthorized,
} from './status-sources.js';
import {
  proposalProductionDiagnosis,
} from './status-production.js';
import {
  learningEvidenceReadinessSources,
} from './status-readiness-signals.js';
import {
  remoteProtectionAuthorityReady,
} from './status-automerge.js';
import {
  existsSync,
} from 'node:fs';
import type {
  RepoProjectKind,
} from '../run/repo-profile.js';
import type {
  PhantomAgentReportRollup,
} from '../types.js';
import {
  phantomAuditSignalSummary,
} from './status-phantom.js';

export function buildAutonomyEffectiveness(status: FleetStatus): FleetAutonomyEffectivenessStatus {
  const readiness = status.autoMergeReadiness;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  const counts: FleetAutonomyEffectivenessStatus['counts'] = {
    backlogItems: status.queue.backlogItems,
    eligibleBacklogItems,
    cooldownItems: status.queue.cooldownItems ?? 0,
    pendingItems: status.queue.pendingItems ?? 0,
    repairRouteBlockedItems: status.queue.repairRouteBlockedItems ?? 0,
    nextEligibleAt: status.queue.nextEligibleAt ?? null,
    pendingProposals: status.proposals.pending,
    frontierPending: status.proposals.frontierPending,
    awaitingHostMerge: status.proposals.awaitingHostMerge ?? 0,
    preflightReady: readiness?.preflightReady ?? 0,
    authorityReady: readiness?.authorityReady ?? 0,
    needsVerification: readiness?.needsVerification ?? 0,
    blocked: readiness?.blocked ?? 0,
    knownVerificationFailed: readiness?.knownVerificationFailed ?? 0,
    recentMerges: status.merges.recent,
  };
  const enrollmentRegistry = status.queue.repos?.registry;
  if (enrollmentRegistry?.state === 'degraded') {
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: enrollment authority degraded (${enrollmentRegistry.reason}).`,
      counts,
    };
  }
  if (status.killSwitch?.state === 'unknown' ||
      status.daemon.sourceQuality?.sourceState !== 'healthy' ||
      status.guardHealth?.sourceQuality?.sourceState !== 'healthy') {
    const reason = status.killSwitch?.state === 'unknown'
      ? 'kill switch source is uninspectable'
      : status.daemon.sourceQuality?.sourceState !== 'healthy'
        ? `daemon state source is degraded (${status.daemon.sourceQuality?.reason ?? 'unavailable'})`
        : 'guard health source is degraded';
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: ${reason}.`,
      counts,
    };
  }
  const firstGuardBlock = status.guardHealth?.blocks?.[0];
  if (status.killed || !status.daemon.running || firstGuardBlock) {
    const reason = status.killed
      ? 'kill switch is engaged'
      : !status.daemon.running
        ? proposalOnceActivationEligible(status)
          ? 'daemon is stopped with one exact proposal activation eligible'
          : residentStandingActivationAuthorized(status)
            ? 'daemon is stopped with valid resident-standing activation authority'
          : `daemon activation is blocked (${status.daemon.activation?.reason ?? 'activation-readiness-unavailable'})`
        : firstGuardBlock?.detail ?? 'guard is blocking';
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: ${reason}.`,
      counts,
    };
  }
  if (status.proposals.authority?.gate === 'unavailable' && (
    counts.pendingProposals > 0 || status.proposals.sourceQuality?.sourceState !== 'missing'
  )) {
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: `Auto-merge authority is unavailable: ${status.proposals.authority.detail}.`,
      counts,
    };
  }
  if (counts.awaitingHostMerge > 0) {
    return {
      phase: 'host-handoff',
      canAutoMergeNow: false,
      bottleneck: 'host-handoff',
      summary: `${counts.awaitingHostMerge} proposal(s) are waiting for host PR merge confirmation.`,
      counts,
    };
  }
  if (
    readiness?.enabled &&
    readiness.configurationBlocker === undefined &&
    (counts.authorityReady ?? 0) > 0
  ) {
    return {
      phase: 'merge-ready',
      canAutoMergeNow: true,
      bottleneck: 'merge-drain',
      summary: `${counts.authorityReady} proposal(s) have complete authority evidence for the auto-merge drain.`,
      counts,
    };
  }
  if (readiness?.enabled && counts.needsVerification > 0) {
    return {
      phase: 'verification-needed',
      canAutoMergeNow: false,
      bottleneck: 'verification',
      summary: `${counts.needsVerification} proposal(s) need verification before judge or merge spend.`,
      counts,
    };
  }
  if (readiness?.enabled && (readiness.authorityBlocked ?? 0) > 0) {
    const topReason = Object.entries(readiness.authorityByReason ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: topReason
        ? `${readiness.authorityBlocked} proposal(s) lack complete merge authority; top blocker: ${topReason}.`
        : `${readiness.authorityBlocked} proposal(s) lack complete merge authority.`,
      counts,
    };
  }
  if (readiness && counts.blocked > 0) {
    const topReason = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: topReason
        ? `${counts.blocked} proposal(s) are blocked at the merge gate; top blocker: ${topReason}.`
        : `${counts.blocked} proposal(s) are blocked at the merge gate.`,
      counts,
    };
  }
  if (counts.pendingProposals === 0 && eligibleBacklogItems > 0) {
    const production = status.proposalProduction;
    const productionDetail = production ? proposalProductionDiagnosis(production) : null;
    const backlogDetail = eligibleBacklogItems === counts.backlogItems
      ? `${counts.backlogItems} backlog item(s) are available`
      : `${eligibleBacklogItems}/${counts.backlogItems} backlog item(s) are eligible now`;
    return {
      phase: 'proposal-starved',
      canAutoMergeNow: false,
      bottleneck: 'proposal-production',
      summary: productionDetail
        ? `${backlogDetail}, but there are no pending proposals for auto-merge; ${productionDetail}.`
        : `${backlogDetail}, but there are no pending proposals for auto-merge.`,
      counts,
    };
  }
  if (counts.pendingProposals === 0 && counts.backlogItems > 0 && eligibleBacklogItems === 0) {
    if ((counts.repairRouteBlockedItems ?? 0) > 0) {
      return {
        phase: 'route-gated',
        canAutoMergeNow: false,
        bottleneck: 'routing',
        summary:
          `No claimable backlog work is visible; ${counts.repairRouteBlockedItems} generated repair item(s) ` +
          `lack an authorized route and remain queued for reevaluation.`,
        counts,
      };
    }
    const nextEligible = counts.nextEligibleAt ? ` Next eligible at ${counts.nextEligibleAt}.` : '';
    return {
      phase: 'cooldown-gated',
      canAutoMergeNow: false,
      bottleneck: 'cooldown',
      summary: `No eligible backlog work is visible; ${counts.cooldownItems ?? 0} item(s) are cooling and ${counts.pendingItems ?? 0} already have pending proposals.${nextEligible}`,
      counts,
    };
  }
  if (
    counts.pendingProposals > 0 ||
    counts.backlogItems > 0 ||
    counts.awaitingHostMerge > 0
  ) {
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary:
        'Work inventory remains visible, but no complete action authority classification is available; ' +
        'inspect queue and proposal source state.',
      counts,
    };
  }
  return {
    phase: 'idle',
    canAutoMergeNow: false,
    bottleneck: 'none',
    summary: counts.recentMerges > 0
      ? `No pending merge work is visible; ${counts.recentMerges} auto-merge(s) landed in the last 24h.`
      : 'No pending proposals or backlog work are visible.',
    counts,
  };
}

export function buildNextActions(status: FleetStatus): FleetNextAction[] {
  const actions: FleetNextAction[] = [];
  const add = (action: FleetNextAction): void => {
    if (actions.some((existing) => existing.id === action.id)) return;
    actions.push(action);
  };

  const enrollmentRegistry = status.queue.repos?.registry;
  if (enrollmentRegistry?.state === 'degraded') {
    add({
      id: 'repair-enrollment-registry',
      priority: 'high',
      label: 'Repair enrollment registry',
      detail:
        `Enrollment authority is degraded (${enrollmentRegistry.reason}); queue inventory and autonomous work are withheld.`,
      commands: [
        nextActionCommand('Inspect enrollment', ['ashlr', 'enroll', 'list', '--json'], 'read-only'),
        nextActionCommand('Run preflight', ['ashlr', 'preflight', '--json'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.killSwitch?.state === 'unknown') {
    add({
      id: 'inspect-kill-switch-source',
      priority: 'critical',
      label: 'Inspect kill switch source',
      detail: 'Kill switch authority is uninspectable; the fleet remains paused until exact state is proven.',
      commands: [
        nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status', '--json'], 'read-only'),
        nextActionCommand('Run diagnostics', ['ashlr', 'doctor'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.daemon.sourceQuality?.sourceState !== 'healthy') {
    add({
      id: 'inspect-daemon-state-source',
      priority: 'critical',
      label: 'Inspect daemon state source',
      detail:
        `Daemon state is ${status.daemon.sourceQuality?.reason ?? 'unavailable'}; ` +
          'stopped/running state and spend are withheld.',
      commands: [
        nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status', '--json'], 'read-only'),
        nextActionCommand('Run diagnostics', ['ashlr', 'doctor'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.guardHealth?.sourceQuality?.sourceState !== 'healthy') {
    add({
      id: 'inspect-guard-health-source',
      priority: 'critical',
      label: 'Inspect guard health source',
      detail: 'Guard health is incomplete; autonomous work remains paused until all guard sources are readable.',
      commands: [
        nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status', '--json'], 'read-only'),
        nextActionCommand('Run diagnostics', ['ashlr', 'doctor'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.killed) {
    add({
      id: 'resume-fleet',
      priority: 'critical',
      label: 'Clear kill switch',
      detail:
        'The global kill switch is engaged. Clearing it does not authorize or start the daemon.',
      commands: [
        nextActionCommand('Clear kill switch', ['ashlr', 'fleet', 'resume'], 'control-plane', {
          endpointMethod: 'POST',
          endpointPath: '/api/fleet/resume',
          tokenRequired: true,
        }),
      ],
    });
  }

  if (!status.daemon.running) {
    const activation = status.daemon.activation;
    if (proposalOnceActivationEligible(status)) {
      add({
        id: 'start-daemon',
        priority: 'critical',
        label: 'Start one proposal cycle',
        detail:
          'A runtime-bound one-use proposal permit is currently valid; daemon start will revalidate and consume it.',
        commands: [
          nextActionCommand(
            'Start one proposal cycle',
            ['ashlr', 'daemon', 'start', '--once'],
            'autonomous-dispatch',
            { note: 'Snapshot-only recommendation; daemon start owns final authority and consumption.' },
          ),
        ],
      });
    } else if (residentStandingActivationAuthorized(status)) {
      add({
        id: 'start-daemon',
        priority: 'critical',
        label: 'Start resident daemon',
        detail:
          'A valid resident-standing grant is present; daemon start will revalidate it before entering the resident loop.',
        commands: [
          nextActionCommand(
            'Start resident daemon',
            ['ashlr', 'daemon', 'start'],
            'autonomous-dispatch',
            { note: 'Snapshot-only recommendation; daemon start owns final authority and revalidation.' },
          ),
        ],
      });
    } else {
      add({
        id: 'inspect-daemon-activation',
        priority: 'critical',
        label: 'Inspect daemon activation authority',
        detail:
          `The daemon is stopped and no exact one-shot proposal activation is currently eligible ` +
          `(${activation?.reason ?? 'activation-readiness-unavailable'}).`,
        commands: [
          nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status'], 'read-only'),
        ],
      });
    }
  }

  const firstGuardBlock = status.guardHealth?.blocks?.[0];
  if (firstGuardBlock) {
    add({
      id: 'repair-guard',
      priority: 'critical',
      label: 'Repair guard block',
      detail: firstGuardBlock.detail,
      target: firstGuardBlock.path,
      commands: [
        nextActionCommand('Inspect guard', ['ashlr', 'daemon', 'status'], 'read-only', {
          note: 'Repair commands are exposed on guardHealth.blocks[].repairCommands.',
        }),
      ],
    });
  }
  const controlBlocked = status.killed || !status.daemon.running || Boolean(firstGuardBlock);

  const phantomAuditAction = phantomAuditNextAction(status.phantom?.agentReport);
  if (phantomAuditAction) add(phantomAuditAction);

  const unhealthyEvidence = learningEvidenceReadinessSources(status, status.generatedAt)
    .filter((source) => source.actionSynthesis === 'eligible' &&
      source.eligibility !== 'observational' &&
      (source.eligibility === 'withheld' || source.status === 'degraded'));
  if (unhealthyEvidence.length > 0) {
    const labels = unhealthyEvidence.slice(0, 3).map((source) => source.label).join(', ');
    const firstSource = unhealthyEvidence[0]!.id;
    const signedEvidenceBlocked = unhealthyEvidence.some((source) => source.id === 'autonomy-packs') &&
      status.proposals.pending > 0;
    add({
      id: signedEvidenceBlocked ? 'inspect-signed-evidence' : 'inspect-learning-evidence',
      priority: signedEvidenceBlocked ? 'high' : 'medium',
      label: signedEvidenceBlocked ? 'Inspect signed evidence authority' : 'Inspect withheld evidence',
      detail:
        `${unhealthyEvidence.length} evidence source(s) are incomplete or degraded, so dependent ` +
        `authority, learning, or analytics remain fail-closed.${labels ? ` Sources: ${labels}.` : ''}`,
      commands: [
        nextActionCommand('Diagnose first withheld source', [
          'ashlr', 'fleet', 'evidence', 'doctor', firstSource, '--json',
        ], 'read-only', {
          note: 'Bounded diagnosis only; never deletes, rewrites, truncates, or bypasses an evidence ledger.',
        }),
        nextActionCommand('Run deep bounded diagnosis', [
          'ashlr', 'fleet', 'evidence', 'doctor', firstSource, '--deep', '--json',
        ], 'read-only', {
          note: 'Uses finite reader hard caps and performs no durable repair.',
        }),
        nextActionCommand('Inspect evidence matrix', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const awaitingHostMerge = status.proposals.awaitingHostMerge ?? 0;
  if (awaitingHostMerge > 0) {
    add({
      id: 'reconcile-host-prs',
      priority: 'high',
      label: 'Inspect host PR reconciliation',
      detail:
        `${awaitingHostMerge} proposal(s) are waiting for GitHub/host merge confirmation. ` +
        'Daemon activation remains governed by the separate one-shot action.',
      commands: [
        nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const readiness = status.autoMergeReadiness;
  const pendingProposalsBlockedByDisabledAutoMerge = Boolean(
    readiness && !readiness.enabled && status.proposals.pending > 0,
  );
  if (pendingProposalsBlockedByDisabledAutoMerge && !controlBlocked) {
    add({
      id: 'inspect-pending-proposals',
      priority: 'high',
      label: 'Inspect pending proposals',
      detail:
        `${status.proposals.pending} proposal(s) are pending while auto-merge is intentionally disabled; ` +
        'inspect their evidence and blockers without changing merge policy.',
      commands: [
        nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }
  if (readiness?.enabled && !controlBlocked) {
    const configurationReady = readiness.configurationBlocker === undefined;
    const remoteProtectionReady = remoteProtectionAuthorityReady(readiness);
    if (!configurationReady) {
      add({
        id: 'inspect-auto-merge-configuration',
        priority: 'high',
        label: 'Inspect auto-merge configuration',
        detail: readiness.configurationBlocker!,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    } else if (!remoteProtectionReady && readiness.remoteProtection) {
      add({
        id: 'inspect-protected-remote',
        priority: (readiness.branchAuthorityReady ?? 0) > 0 ? 'medium' : 'high',
        label: 'Inspect protected remote authority',
        detail: readiness.remoteProtection.detail,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only', {
            note: 'Remote-main automation remains blocked until exact live fleet coverage is available.',
          }),
        ],
      });
    }
    if (configurationReady && (readiness.authorityReady ?? 0) > 0) {
      add({
        id: 'drain-ready-auto-merges',
        priority: 'high',
        label: 'Drain ready auto-merges',
        detail:
          `${readiness.authorityReady} pending proposal(s) have complete read-only authority evidence. ` +
          'The running daemon owns scheduling; monitor the evidence without starting a second process.',
        commands: [
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    }
    if (
      (readiness.authorityBlocked ?? 0) > 0 &&
      (readiness.authorityReady ?? 0) === 0 &&
      readiness.needsVerification === 0
    ) {
      const topReason = Object.entries(readiness.authorityByReason ?? {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      add({
        id: 'inspect-auto-merge-authority',
        priority: 'high',
        label: 'Inspect merge authority',
        detail: topReason
          ? `${topReason[1]}x ${topReason[0]}`
          : `${readiness.authorityBlocked} proposal(s) lack complete authority evidence.`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        ],
      });
    }
    if (readiness.needsVerification > 0) {
      add({
        id: 'verify-pending-proposals',
        priority: 'high',
        label: 'Verify pending proposals',
        detail:
          `${readiness.needsVerification} proposal(s) need verification before judge or merge spend. ` +
          'The running daemon owns scheduling; monitor verification without starting a second process.',
        commands: [
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    }
    if (readiness.knownVerificationFailed > 0) {
      add({
        id: 'repair-verification-failures',
        priority: 'high',
        label: 'Drain failed proposals',
        detail:
          `${readiness.knownVerificationFailed} proposal(s) have permanent verification blockers. ` +
          'The running daemon owns maintenance scheduling; inspect the failures without starting a second process.',
        commands: [
          nextActionCommand('Inspect failed proposals', ['ashlr', 'inbox', '--json'], 'read-only'),
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    }
    if (readiness.blocked > 0 && readiness.preflightReady === 0 && readiness.needsVerification === 0) {
      const topReason = Object.entries(readiness.byReason)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      add({
        id: 'inspect-auto-merge-blockers',
        priority: 'medium',
        label: 'Inspect merge blockers',
        detail: topReason ? `${topReason[1]}x ${topReason[0]}` : `${readiness.blocked} proposal(s) are blocked.`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        ],
      });
    }
  }

  const constrained = status.backends.find((backend) => {
    const availability = backend.resource?.availability;
    return availability === 'exhausted' || availability === 'throttled' || availability === 'unreachable';
  });
  if (constrained?.resource) {
    add({
      id: `resource-${constrained.backend}`,
      priority: constrained.resource.availability === 'exhausted' ? 'high' : 'medium',
      label: `Route around ${constrained.backend}`,
      detail: constrained.resource.reason,
      target: constrained.backend,
      commands: [
        nextActionCommand('Inspect resources', ['ashlr', 'resources', '--json'], 'read-only'),
        nextActionCommand('Inspect direction', ['ashlr', 'fleet', 'direction', '--json'], 'read-only'),
      ],
    });
  }

  const goalFocus = status.goalFocus;
  const staleLane = status.laneLocks?.samples.find(
    (sample) => sample.reason === 'stale-in-progress' && sample.goalId && sample.milestoneId,
  );
  if (status.laneLocks && status.laneLocks.staleInProgress > 0) {
    const staleCount = status.laneLocks.staleInProgress;
    add({
      id: 'recover-stale-goal-lanes',
      priority: 'high',
      label: 'Recover stale goal lanes',
      detail:
        `${staleCount} in-progress goal milestone(s) are stale.` +
        `${staleLane?.title ? ` First: ${staleLane.title}.` : ''}`,
      ...(staleLane?.repo ? { target: staleLane.repo } : {}),
      commands: [
        ...(staleLane?.goalId
          ? [nextActionCommand('Inspect goal', ['ashlr', 'goals', 'show', staleLane.goalId, '--json'], 'read-only')]
          : [nextActionCommand('List goals', ['ashlr', 'goals', 'list', '--json'], 'read-only')]),
        nextActionCommand('Recover stale lanes', ['ashlr', 'goals', 'recover-stale'], 'control-plane', {
          note: 'Goal-store only; resets stale proposal-less in-progress milestones back to pending.',
        }),
      ],
    });
  }
  if (goalFocus?.deferredNewGoalWork) {
    add({
      id: 'close-active-goals',
      priority: 'medium',
      label: 'Close active goals',
      detail:
        `Goal focus is holding new planning/invent work: ` +
        `${goalFocus.actionableActiveGoalCount}/${goalFocus.activeThreshold} active goal(s) have actionable milestones. ` +
        `Cached queue has ${goalFocus.visibleGoalBacklogItems} goal item(s) and ${goalFocus.visibleInventBacklogItems} invent item(s).`,
      commands: [
        nextActionCommand('List goals', ['ashlr', 'goals', 'list', '--json'], 'read-only'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const routeBlockedItems = status.queue.repairRouteBlockedItems ?? 0;
  const addRestoreRepairRoutes = (): void => {
    if (routeBlockedItems === 0 || controlBlocked) return;
    const topReason = status.queue.generatedRepairRoutes?.byReason.find((entry) => entry.reason !== 'feasible');
    add({
      id: 'restore-repair-routes',
      priority: 'medium',
      label: 'Restore repair routes',
      detail:
        `${routeBlockedItems} generated repair item(s) remain queued but cannot be claimed` +
        `${topReason ? `; top reason: ${topReason.reason} (${topReason.count})` : ''}.`,
      commands: [
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        nextActionCommand('Inspect resources', ['ashlr', 'resources', '--json'], 'read-only'),
        nextActionCommand('Inspect direction', ['ashlr', 'fleet', 'direction', '--json'], 'read-only'),
      ],
    });
  };

  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (eligibleBacklogItems === 0) addRestoreRepairRoutes();
  if (eligibleBacklogItems > 0 && !controlBlocked) {
    const top = status.queue.next?.[0];
    add({
      id: 'build-backlog',
      priority: 'medium',
      label: 'Build backlog proposals',
      detail: top
        ? `Start with ${top.title}`
        : `${eligibleBacklogItems} backlog item(s) are eligible.`,
      ...(top?.repo ? { target: top.repo } : {}),
      commands: [
        nextActionCommand('Run one proposal cycle', ['ashlr', 'loop'], 'autonomous-dispatch', {
          ...(top?.repo ? { cwd: top.repo } : {}),
          note: 'Proposal-only; respects daemon singleton, kill switch, enrollment, and budget guards.',
        }),
      ],
    });
    addRestoreRepairRoutes();
  } else if (status.queue.backlogItems > 0 && !controlBlocked) {
    const cooling = status.queue.cooldownItems ?? 0;
    const pending = status.queue.pendingItems ?? 0;
    const repairBlocked = status.queue.repairControlBlockedItems ?? 0;
    const nextEligible = status.queue.nextEligibleAt;
    if (repairBlocked > 0) {
      const unavailable = status.queue.repairLifecycleUnavailableItems ?? 0;
      const terminal = status.queue.repairTerminalItems ?? 0;
      add({
        id: 'inspect-repair-lifecycle-control',
        priority: 'medium',
        label: 'Inspect repair lifecycle control',
        detail: `${repairBlocked} generated repair item(s) are lifecycle/control blocked ` +
          `(${unavailable} unavailable, ${terminal} terminal).`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    } else if (cooling > 0 && eligibleBacklogItems === 0) {
      add({
        id: 'cooldown-gated-backlog',
        priority: 'medium',
        label: 'Review cooldown gate',
        detail: nextEligible
          ? `${status.queue.backlogItems} backlog item(s) are cooling; next eligible at ${nextEligible}. Decide whether to wait, lower cooldown policy, or dispatch a targeted high-value item.`
          : `${status.queue.backlogItems} backlog item(s) are visible but none are eligible. Decide whether to wait, inspect worked-ledger cooldowns, or dispatch a targeted high-value item.`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
          nextActionCommand('Dry-run loop', ['ashlr', 'loop', '--dry-run'], 'read-only'),
        ],
      });
    }
    if (repairBlocked === 0) {
      add({
        id: 'wait-for-backlog-eligibility',
        priority: 'low',
        label: 'Wait for backlog eligibility',
        detail: nextEligible
          ? `${status.queue.backlogItems} backlog item(s) are present, but ${cooling} are cooling and ${pending} already have pending proposals; next eligible at ${nextEligible}.`
          : `${status.queue.backlogItems} backlog item(s) are present, but none are currently eligible (${cooling} cooling, ${pending} pending).`,
        commands: [
          nextActionCommand('Watch fleet', ['ashlr', 'fleet', 'watch'], 'read-only'),
        ],
      });
    }
  }

  const missingVerify = status.queue.repos?.executionProfiles?.reposMissingVerifyCommands ?? 0;
  if (missingVerify > 0) {
    const missingRepos = status.queue.repos?.executionProfiles?.missingVerifyCommands ?? [];
    const sample = missingRepos.slice(0, 3).map(formatExecutionProfileSample).join(', ');
    add({
      id: 'add-repo-verify-contracts',
      priority: 'low',
      label: 'Add repo verify contracts',
      detail: `${missingVerify} enrolled repo(s) have no detected verify commands.${sample ? ` First: ${sample}.` : ''}`,
      commands: [
        nextActionCommand('Inspect missing verifiers', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }
  const missingExplicitMergeContracts =
    status.queue.repos?.executionProfiles?.reposMissingExplicitMergeContracts ?? 0;
  if (missingExplicitMergeContracts > 0) {
    const missingRepos = status.queue.repos?.executionProfiles?.missingExplicitMergeContracts ?? [];
    const sample = missingRepos.slice(0, 3).map(formatExecutionProfileSample).join(', ');
    add({
      id: 'add-explicit-merge-verify-contracts',
      priority: 'medium',
      label: 'Add explicit merge verify contracts',
      detail:
        `${missingExplicitMergeContracts} enrolled repo(s) rely on inferred or non-merge verification.` +
        `${sample ? ` First: ${sample}.` : ''}`,
      commands: [
        nextActionCommand('Inspect merge contracts', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        nextActionCommand('Edit verify contract', ['vi', 'ashlr.verify.json'], 'manual', {
          ...(missingRepos[0]?.repo && existsSync(missingRepos[0].repo) ? { cwd: missingRepos[0].repo } : {}),
          note: 'Create a required merge-profile repo-owned verification contract.',
        }),
      ],
    });
  }

  if (actions.length === 0) {
    add({
      id: 'refresh-backlog',
      priority: 'low',
      label: 'Refresh backlog',
      detail: 'No immediate blockers or ready work are visible in the current snapshot.',
      commands: [
        nextActionCommand('Refresh backlog', ['ashlr', 'backlog', 'refresh'], 'control-plane'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const priorityRank: Record<FleetNextAction['priority'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const actionRank = (action: FleetNextAction): number => {
    if (action.id === 'repair-verification-failures' && (status.autoMergeReadiness?.knownVerificationFailed ?? 0) > 0) return -1.4;
    if (action.id === 'review-phantom-audit') return -1.3;
    if (action.id === 'drain-diagnostic-reslices' && (status.autoMergeReadiness?.knownVerificationFailed ?? 0) === 0) return -1.2;
    if (action.id === 'process-capture-repairs' && (status.autoMergeReadiness?.knownVerificationFailed ?? 0) === 0) return -1.1;
    if (action.id === 'inspect-dispatch-yield') return -1;
    if (action.id === 'inspect-learning-evidence') return 1;
    if (action.id === 'add-explicit-merge-verify-contracts') return 0.5;
    return 0;
  };
  return actions
    .sort((a, b) =>
      priorityRank[a.priority] - priorityRank[b.priority] ||
      actionRank(a) - actionRank(b) ||
      a.id.localeCompare(b.id),
    )
    .slice(0, 6);
}

function formatExecutionProfileSample(row: {
  name: string;
  projectKinds: RepoProjectKind[];
  reason: string;
}): string {
  const kind = row.projectKinds.length > 0 ? row.projectKinds.join('+') : 'unknown';
  return `${row.name} [${kind}: ${row.reason}]`;
}

function phantomAuditNextAction(report: PhantomAgentReportRollup | undefined): FleetNextAction | null {
  const summary = phantomAuditSignalSummary(report);
  if (!summary) return null;

  return {
    id: 'review-phantom-audit',
    priority: 'high',
    label: 'Review Phantom audit',
    detail: summary.detail,
  };
}

export function buildMissionBrief(status: FleetStatus): FleetMissionBrief {
  const readiness = status.autonomousShipReadiness ?? null;
  const effectiveness = status.autonomyEffectiveness ?? null;
  const action = readiness?.primaryAction ?? (status.nextActions ?? [])[0] ?? null;
  const blocker = readiness?.topBlocker ?? null;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  const preflightReady = status.autoMergeReadiness?.preflightReady ?? effectiveness?.counts.preflightReady ?? 0;
  const guardBlocked = status.guardHealth?.blocked ?? (status.guardHealth?.blocks?.length ?? 0) > 0;

  return {
    generatedAt: status.generatedAt,
    directive: missionDirective(status, action, effectiveness),
    confidence: readiness?.confidence ?? 'low',
    operatingMode: status.autonomyDirection?.mode ?? effectiveness?.phase ?? 'unknown',
    blocker,
    action,
    whyNow: missionWhyNow(status, blocker, action, effectiveness),
    evidence: {
      readinessVerdict: readiness?.verdict ?? null,
      effectivenessPhase: effectiveness?.phase ?? null,
      bottleneck: effectiveness?.bottleneck ?? null,
      queueBacklogItems: status.queue.backlogItems,
      eligibleBacklogItems,
      pendingProposals: status.proposals.pending,
      preflightReady,
      guardBlocked,
    },
  };
}

function missionDirective(
  status: FleetStatus,
  action: FleetNextAction | null,
  effectiveness: FleetAutonomyEffectivenessStatus | null,
): string {
  if (action?.id === 'repair-enrollment-registry') return 'Repair enrollment authority';
  if (action?.id === 'inspect-kill-switch-source') return 'Inspect kill switch authority';
  if (action?.id === 'inspect-daemon-state-source') return 'Inspect daemon state';
  if (action?.id === 'inspect-guard-health-source') return 'Inspect guard health';
  if (status.killed) return 'Clear the kill switch';
  if (action?.id === 'inspect-daemon-activation') return 'Inspect daemon activation authority';
  if (!status.daemon.running) {
    return residentStandingActivationAuthorized(status)
      ? 'Start resident daemon'
      : 'Start one proposal cycle';
  }
  if (status.guardHealth?.blocked) return 'Repair the guard block';

  switch (action?.id) {
    case 'reconcile-host-prs':
      return 'Reconcile host PRs';
    case 'drain-ready-auto-merges':
      return 'Drain ready auto-merges';
    case 'verify-pending-proposals':
      return 'Verify pending proposals';
    case 'repair-verification-failures':
      return 'Drain failed proposal blockers';
    case 'inspect-auto-merge-blockers':
      return 'Inspect merge blockers';
    case 'review-phantom-audit':
      return 'Review Phantom audit';
    case 'repair-enrollment-registry':
      return 'Repair enrollment authority';
    case 'inspect-learning-evidence':
      return 'Diagnose withheld evidence';
    case 'build-backlog':
      return 'Build the highest-value backlog proposal';
    case 'cooldown-gated-backlog':
      return 'Review the backlog cooldown gate';
    case 'add-repo-verify-contracts':
      return 'Add missing repo verification contracts';
    case 'add-explicit-merge-verify-contracts':
      return 'Add explicit merge verification contracts';
  }

  switch (effectiveness?.phase) {
    case 'host-handoff':
      return 'Reconcile host PRs';
    case 'merge-ready':
      return 'Drain ready auto-merges';
    case 'verification-needed':
      return 'Verify pending proposals';
    case 'merge-blocked':
      return 'Inspect merge blockers';
    case 'proposal-starved':
      return 'Convert eligible backlog into proposals';
    case 'cooldown-gated':
      return 'Wait for backlog eligibility';
    case 'idle':
      return status.merges.recent > 0 ? 'Refill the backlog after recent merges' : 'Discover high-value backlog work';
    case 'control-blocked':
      return 'Restore autonomous control';
  }

  return 'Refresh fleet status and backlog';
}

function missionWhyNow(
  status: FleetStatus,
  blocker: FleetAutonomousShipReadinessBlocker | null,
  action: FleetNextAction | null,
  effectiveness: FleetAutonomyEffectivenessStatus | null,
): string {
  if (action?.id === 'review-phantom-audit' && action.detail) return action.detail;
  if (blocker?.detail) return blocker.detail;
  if (effectiveness?.summary) return effectiveness.summary;
  if (action?.detail) return action.detail;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (eligibleBacklogItems > 0) {
    return `${eligibleBacklogItems} eligible backlog item(s) are visible.`;
  }
  return 'No higher-confidence autonomous action is visible in the current snapshot.';
}

function commandShell(argv: string[]): string {
  return argv.map((part) => {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) return part;
    return `'${part.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

function nextActionCommand(
  label: string,
  argv: string[],
  safety: FleetNextActionCommandSafety,
  extras: Omit<FleetNextActionCommand, 'label' | 'argv' | 'shell' | 'safety'> = {},
): FleetNextActionCommand {
  return {
    label,
    argv,
    shell: commandShell(argv),
    safety,
    ...extras,
  };
}
