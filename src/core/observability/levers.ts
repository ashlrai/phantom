import type { ActivityRollup } from '../types.js';
import type { FleetDigest } from '../fleet/digest.js';

export type MetricsLeverId = 'lane-imbalance' | 'template-merge-rate' | 'wait-time' | 'empty-jobs';

export interface MetricsLever {
  rank: number;
  id: MetricsLeverId;
  /** Opportunity index from 0 to 100, not predicted impact; null means unknown. */
  score: number | null;
  evidence: 'proxy' | 'unavailable';
  reason: string;
}

/**
 * Rank comparable fractional opportunity proxies from existing rollups only.
 * These sources do not measure lanes, templates, queue duration or empty jobs.
 * Ties follow the fixed candidate order below; unavailable evidence sorts last.
 */
export function rankMetricsLevers(activity: ActivityRollup, fleet: FleetDigest): {
  schemaVersion: 1;
  window: string;
  since: string;
  levers: MetricsLever[];
} {
  const candidates: Omit<MetricsLever, 'rank'>[] = [];
  const add = (id: MetricsLeverId, fraction: number | null, reason: string): void => {
    candidates.push({ id, score: fraction === null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 10_000) / 100,
      evidence: fraction === null ? 'unavailable' : 'proxy', reason });
  };
  const projects = activity.byProject.filter(p => p.sessions > 0);
  const sessions = projects.reduce((sum, p) => sum + p.sessions, 0);
  const counts = projects.map(p => p.sessions);
  add('lane-imbalance', projects.length > 1 ? (Math.max(...counts) - Math.min(...counts)) / sessions : null,
    projects.length > 1
      ? `Rebalance activity: project session counts range from ${Math.min(...counts)} to ${Math.max(...counts)}; project concentration is a proxy, not lane utilization.`
      : 'Lane imbalance unavailable: need at least two active projects; no lane utilization is recorded.');

  const quality = fleet.proposalSourceQuality;
  const complete = quality?.complete === true && quality.sourceState !== 'degraded';
  const proposed = fleet.totalProposed;
  add('template-merge-rate', complete && proposed > 0 ? 1 - fleet.totalAutoMerged / proposed : null,
    complete && proposed > 0
      ? `Improve conversion: ${fleet.totalAutoMerged} witnessed merges and ${proposed} digest-counted non-pending proposals in the window; fleet flow is a proxy, not a template cohort merge rate.`
      : 'Template merge rate unavailable: no complete proposal sample; template identities are not recorded in the rollups.');

  const reviewLoad = fleet.totalPending + fleet.totalAutoMerged + fleet.totalDeclined;
  add('wait-time', complete && reviewLoad > 0 ? fleet.totalPending / reviewLoad : null,
    complete && reviewLoad > 0
      ? `Drain review backlog: ${fleet.totalPending} live pending versus ${fleet.totalAutoMerged + fleet.totalDeclined} window merges and declines; backlog share is a proxy, not elapsed wait time.`
      : 'Wait time unavailable: no complete review sample; queue timestamps are not recorded in the rollups.');

  const unproductive = projects.filter(p => p.commits === 0).reduce((sum, p) => sum + p.sessions, 0);
  add('empty-jobs', sessions > 0 ? unproductive / sessions : null,
    sessions > 0
      ? `Inspect output: ${unproductive}/${sessions} project sessions belong to projects with zero window commits; this proxy does not prove jobs were empty.`
      : 'Empty jobs unavailable: no attributed sessions; job outcomes are not recorded in the rollups.');

  return { schemaVersion: 1, window: activity.window, since: activity.since,
    levers: candidates.map((candidate, order) => ({ candidate, order }))
      .sort((a, b) => (b.candidate.score ?? -1) - (a.candidate.score ?? -1) || a.order - b.order)
      .slice(0, 3).map(({ candidate }, index) => ({ rank: index + 1, ...candidate })) };
}
