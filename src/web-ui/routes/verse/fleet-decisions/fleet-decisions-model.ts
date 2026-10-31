import type { OpsFleetV1 } from '../../../../core/verse/ops-types.js';

export type Filter = 'all' | 'launched' | 'skipped';

export function decisionRows(fleet: OpsFleetV1, filter: Filter) {
  return fleet.decisions.map((d, index) => ({
    key: `${d.itemId}:${d.at}:${index}`, at: d.at, repo: d.repo, title: d.title,
    target: d.lane ?? d.seatId ?? '—', launched: d.dispatched,
    reason: d.skipReason ?? d.why ?? d.summary ?? '—', candidates: d.candidates.length,
  })).filter(d => filter === 'all' || d.launched === (filter === 'launched'))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

export function decisionSummary(fleet: OpsFleetV1) {
  const rows = decisionRows(fleet, 'all');
  return {
    launched: rows.filter(d => d.launched).length,
    skipped: rows.filter(d => !d.launched).length,
    lastLaunchAt: rows.find(d => d.launched)?.at ?? null,
    lastSkipReason: rows.find(d => !d.launched)?.reason ?? null,
  };
}

export function holdRows(fleet: OpsFleetV1) {
  return fleet.held.map((h, index) => ({
    key: `${h.itemId}:${h.at}:${index}`, repo: h.repo, title: h.title,
    holdKind: h.holdKind, reason: h.reason, nextEligibleAt: h.nextEligibleAt,
  })).sort((a, b) => {
    const left = a.nextEligibleAt ? Date.parse(a.nextEligibleAt) : NaN;
    const right = b.nextEligibleAt ? Date.parse(b.nextEligibleAt) : NaN;
    return (Number.isFinite(left) ? left : Infinity) - (Number.isFinite(right) ? right : Infinity) || 0;
  });
}

export function stallNote(summary: ReturnType<typeof decisionSummary>, _tickAt: string | null, _nowMs: number): string | null {
  return summary.launched === 0 && summary.skipped > 0
    ? `No launches in the journal window; last skip: ${summary.lastSkipReason ?? '—'}` : null;
}
