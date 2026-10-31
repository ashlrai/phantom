import type { OpsFleetV1 } from '../../../../core/verse/ops-types.js';
import { splitRefs } from '../fleet/job-refs.js';

export type Filter = 'all' | 'launched' | 'skipped';

export function decisionPr(title: string, snapshot: {
  publishesLastHour?: Array<{ job: string; url: string | null }>;
  mergesLastHour?: { items: Array<{ repo: string; number: number; title: string }> };
} | undefined): { label: string; href: string | null; state: 'merged' | 'published' } | null {
  const job = splitRefs(title).find(segment => segment.kind === 'job')?.value;
  if (!job) return null;
  const merged = snapshot?.mergesLastHour?.items.find(item => item.title.includes(job));
  if (merged) {
    const parts = merged.repo.split('/');
    const safe = /^[\w.-]+\/[\w.-]+$/.test(merged.repo) && parts.every(part => part !== '.' && part !== '..')
      && Number.isSafeInteger(merged.number) && merged.number > 0;
    return { label: `PR #${merged.number} · merged`, href: safe ? `https://github.com/${merged.repo}/pull/${merged.number}` : null, state: 'merged' };
  }
  const published = snapshot?.publishesLastHour?.find(item => item.job === job && item.url !== null);
  if (!published) return null;
  return { label: 'PR · published', href: published.url?.startsWith('https://github.com/') ? published.url : null, state: 'published' };
}

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

export function repeatedSkips(fleet: OpsFleetV1, minRuns = 3): Array<{ itemId: string; title: string; runs: number; since: string; reason: string }> {
  const groups = new Map<string, typeof fleet.decisions>();
  for (const d of fleet.decisions) {
    if (!d || typeof d.itemId !== 'string' || typeof d.at !== 'string' || typeof d.dispatched !== 'boolean') continue;
    const group = groups.get(d.itemId) ?? [];
    group.push(d);
    groups.set(d.itemId, group);
  }
  const repeats: ReturnType<typeof repeatedSkips> = [];
  for (const [itemId, group] of groups) {
    group.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    const streak = group.findIndex(d => d.dispatched);
    const runs = streak === -1 ? group.length : streak;
    if (runs < minRuns || runs === 0) continue;
    const newest = group[0];
    const reason = [newest.skipReason, newest.why, newest.summary].find(value => typeof value === 'string') ?? '—';
    repeats.push({ itemId, title: typeof newest.title === 'string' ? newest.title : itemId, runs, since: group[runs - 1].at, reason });
  }
  return repeats.sort((a, b) => b.runs - a.runs || a.title.localeCompare(b.title));
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

export function stallNote(summary: ReturnType<typeof decisionSummary>, _tickAt: string | null, _nowMs: number, repeatedCount = 0): string | null {
  return summary.launched === 0 && summary.skipped > 0
    ? `No launches in the journal window; last skip: ${summary.lastSkipReason ?? '—'}${repeatedCount > 0 ? ` · ${repeatedCount} bets skipped 3+ ticks in a row` : ''}` : null;
}
