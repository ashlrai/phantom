/** Fleet status: production. Internal to status.ts. */

import type {
  DaemonTick,
  DaemonDispatchTrace,
} from '../types.js';
import type {
  FleetProposalProductionStatus,
  FleetProposalProductionDispatchSummary,
} from './status-types.js';
import {
  RECENT_WINDOW_MS,
} from './status-sources.js';

export function buildProposalProductionStatus(ticks: DaemonTick[]): FleetProposalProductionStatus | undefined {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = ticks.filter((tick) => {
    if (!tick.proposalProduction) return false;
    const ts = Date.parse(tick.ts);
    return Number.isNaN(ts) || ts >= cutoff;
  });
  if (recent.length === 0) return undefined;

  const reasons = new Map<string, number>();
  const diagnosticReasons = new Map<string, number>();
  const skipReasons = new Map<string, number>();
  const recentNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  const recentDiagnosticNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  let selected = 0;
  let claimed = 0;
  let dispatched = 0;
  let skipped = 0;
  let errors = 0;
  let proposalsCreated = 0;
  let noProposalDispatches = 0;
  let suppressedDispatches = 0;

  const addReason = (reason: string, count = 1): void => {
    const key = reason.trim() || 'unknown';
    reasons.set(key, (reasons.get(key) ?? 0) + count);
  };

  const addDiagnosticReason = (reason: string | undefined, count = 1): boolean => {
    const key = (reason ?? '').trim() || 'unknown';
    if (!isSuppressedProposalProductionReason(key) && !isSkippedProposalProductionReason(key)) {
      diagnosticReasons.set(key, (diagnosticReasons.get(key) ?? 0) + count);
      return true;
    }
    return false;
  };

  const addSkipReason = (reason: string | undefined, count = 1): void => {
    const key = (reason ?? '').trim() || 'unknown';
    skipReasons.set(key, (skipReasons.get(key) ?? 0) + count);
  };

  for (const tick of recent) {
    const production = tick.proposalProduction;
    if (!production) continue;
    selected += production.selected;
    claimed += production.claimed;
    dispatched += production.dispatched;
    skipped += production.skipped;
    errors += production.errors;
    proposalsCreated += production.proposalsCreated;
    noProposalDispatches += production.noProposalDispatches;
    let hasAggregateDiagnosticReason = false;
    let sawSkippedDispatchReason = false;
    for (const reason of production.reasons ?? []) {
      addReason(reason.reason, reason.count);
      if (isSkippedProposalProductionReason(reason.reason)) continue;
      hasAggregateDiagnosticReason = addDiagnosticReason(reason.reason, reason.count) || hasAggregateDiagnosticReason;
    }
    for (const dispatch of tick.dispatches ?? []) {
      if (dispatch.dispatched) continue;
      addSkipReason(dispatch.skipReason ?? dispatch.reason);
      sawSkippedDispatchReason = true;
    }
    if (!sawSkippedDispatchReason) {
      for (const reason of production.reasons ?? []) {
        if (isSkippedProposalProductionReason(reason.reason)) {
          addSkipReason(reason.reason, reason.count);
        }
      }
    }
    if (production.noProposalDispatches > 0 && recentNoProposalDispatches.length < 8) {
      const knownNoProposalDispatches = (tick.dispatches ?? []).filter((dispatch) =>
        dispatch.dispatched &&
        dispatch.production !== undefined &&
        dispatch.production.outcome !== 'proposal-created',
      );
      let suppressedByReason = 0;
      for (const reason of production.reasons ?? []) {
        if (isSuppressedProposalProductionReason(reason.reason)) {
          suppressedByReason += reason.count;
        }
      }
      const suppressedByDispatch = knownNoProposalDispatches
        .filter(isSuppressedProposalProductionDispatch)
        .length;
      suppressedDispatches += Math.max(suppressedByReason, suppressedByDispatch);
      const sample = knownNoProposalDispatches.length > 0
        ? knownNoProposalDispatches
        : (tick.dispatches ?? []).filter((dispatch) => dispatch.dispatched).slice(0, production.noProposalDispatches);
      for (const dispatch of sample) {
        if (recentNoProposalDispatches.length >= 8) break;
        const summary = proposalProductionDispatchSummary(tick.ts, dispatch);
        recentNoProposalDispatches.push(summary);
        if (isSuppressedProposalProductionDispatch(dispatch)) {
          continue;
        }
        if (!hasAggregateDiagnosticReason) {
          addDiagnosticReason(proposalProductionDiagnosticReason(dispatch));
        }
        if (recentDiagnosticNoProposalDispatches.length < 8) {
          recentDiagnosticNoProposalDispatches.push(summary);
        }
      }
    } else {
      for (const reason of production.reasons ?? []) {
        if (isSuppressedProposalProductionReason(reason.reason)) {
          suppressedDispatches += reason.count;
        }
      }
    }
  }

  const diagnosticNoProposalDispatches = Math.max(0, noProposalDispatches - suppressedDispatches);
  return {
    windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
    selected,
    claimed,
    dispatched,
    skipped,
    errors,
    proposalsCreated,
    noProposalDispatches,
    suppressedDispatches,
    diagnosticNoProposalDispatches,
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    diagnosticTopReasons: [...diagnosticReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    skipReasons: [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    recentNoProposalDispatches,
    recentDiagnosticNoProposalDispatches,
  };
}

export function isSuppressedProposalProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').toLowerCase();
  return normalized.startsWith('proposal-disabled') ||
    normalized.includes('proposal filing disabled');
}

function isSkippedProposalProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').trim().toLowerCase();
  return normalized === 'not-attempted' ||
    normalized.startsWith('not-attempted:') ||
    normalized.includes('selected item(s) were not attempted');
}

function isSuppressedProposalProductionDispatch(dispatch: DaemonDispatchTrace): boolean {
  return dispatch.production?.outcome === 'proposal-disabled' ||
    isSuppressedProposalProductionReason(dispatch.production?.reason) ||
    isSuppressedProposalProductionReason(dispatch.reason);
}

function proposalProductionDiagnosticReason(dispatch: DaemonDispatchTrace): string {
  const reason = (dispatch.production?.reason ?? dispatch.reason ?? 'unknown').trim() || 'unknown';
  const outcome = dispatch.production?.outcome;
  if (!outcome || outcome === 'unknown' || outcome === 'proposal-created') return reason;
  return reason.startsWith(`${outcome}:`) ? reason : `${outcome}: ${reason}`;
}

function proposalProductionDispatchSummary(
  ts: string,
  dispatch: DaemonDispatchTrace,
): FleetProposalProductionDispatchSummary {
  return {
    ts,
    itemId: dispatch.itemId,
    title: dispatch.title,
    repo: dispatch.repo,
    source: dispatch.source,
    backend: dispatch.backend,
    ...(dispatch.production?.outcome ? { productionOutcome: dispatch.production.outcome } : {}),
    reason: dispatch.production?.reason ?? dispatch.skipReason ?? dispatch.reason,
  };
}

export function proposalProductionDiagnosis(production: FleetProposalProductionStatus): string {
  const diagnosticTopReason = production.diagnosticTopReasons[0];
  const topReason = diagnosticTopReason ??
    production.topReasons.find((reason) =>
      !isSuppressedProposalProductionReason(reason.reason) &&
      !isSkippedProposalProductionReason(reason.reason)
    );
  const diagnosticNoProposalDispatches = production.diagnosticNoProposalDispatches ?? production.noProposalDispatches;
  if (production.errors > 0) {
    return `recent production saw ${production.errors} error(s)${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (diagnosticNoProposalDispatches > 0) {
    return `${diagnosticNoProposalDispatches} recent dispatch(es) produced no proposal${diagnosticTopReason ? `; top reason: ${diagnosticTopReason.reason}` : ''}`;
  }
  if (production.skipped > 0) {
    const topSkip = production.skipReasons[0];
    return `${production.skipped} selected item(s) were not attempted${topSkip ? `; top skip: ${topSkip.reason}` : ''}`;
  }
  if (production.suppressedDispatches > 0) {
    return `${production.suppressedDispatches} recent dispatch(es) were suppressed by internal proposal filing policy`;
  }
  if (production.selected > 0 && production.dispatched === 0) {
    return `${production.selected} item(s) were selected but none dispatched${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.dispatched > 0 && production.proposalsCreated > 0) {
    return `${production.dispatched} dispatch(es) produced ${production.proposalsCreated} proposal(s)`;
  }
  return topReason ? `recent production top reason: ${topReason.reason}` : 'no recent proposal-production diagnosis is available';
}
