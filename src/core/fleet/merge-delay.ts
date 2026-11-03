/** Injected observations only; no GitHub access or merge side effects. */
export interface MergeDelayEvent {
  repo: string;
  pr: number;
  event: 'published' | 'auto_merge_enabled' | 'merged';
  at: string;
}
export function buildMergeDelay(events: readonly MergeDelayEvent[], now: Date) {
  const observed = now.getTime();
  if (!Number.isFinite(observed)) throw new Error('Invalid observation time');
  const groups = new Map<string, { repo: string; pr: number; times: Partial<Record<MergeDelayEvent['event'], number>> }>();
  for (const row of events) {
    if (!row || typeof row.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(row.repo)
      || !Number.isSafeInteger(row.pr) || row.pr <= 0
      || !['published', 'auto_merge_enabled', 'merged'].includes(row.event)
      || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) > observed) {
      throw new Error('Invalid merge delay event');
    }
    const key = `${row.repo}#${row.pr}`;
    const group = groups.get(key) ?? { repo: row.repo, pr: row.pr, times: {} };
    group.times[row.event] = Math.min(group.times[row.event] ?? Infinity, Date.parse(row.at));
    groups.set(key, group);
  }
  const seconds = (start?: number, end?: number): number | null =>
    start === undefined || end === undefined || end < start ? null : (end - start) / 1000;
  const rows = [...groups.values()].map(({ repo, pr, times: t }) => {
    const invalidOrder = (t.published !== undefined && t.auto_merge_enabled !== undefined && t.auto_merge_enabled < t.published)
      || (t.merged !== undefined && ((t.published !== undefined && t.merged < t.published)
        || (t.auto_merge_enabled !== undefined && t.merged < t.auto_merge_enabled)));
    const enrollmentWaitSeconds = t.auto_merge_enabled === undefined && t.merged === undefined ? seconds(t.published, observed) : null;
    return { repo, pr, status: invalidOrder ? 'invalid_order' : t.merged !== undefined ? 'merged'
      : t.auto_merge_enabled !== undefined ? 'awaiting_merge' : t.published !== undefined ? 'awaiting_enrollment' : 'unknown',
    publicationToEnrollmentSeconds: seconds(t.published, t.auto_merge_enabled),
    enrollmentToMergeSeconds: seconds(t.auto_merge_enabled, t.merged),
    publicationToMergeSeconds: seconds(t.published, t.merged), enrollmentWaitSeconds,
    mergeWaitSeconds: t.merged === undefined ? seconds(t.auto_merge_enabled, observed) : null,
    stalledEnrollment: enrollmentWaitSeconds !== null && enrollmentWaitSeconds >= 1800 };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
  return { schema: 'fleet.merge-delay.v1' as const, collectedAt: now.toISOString(), stallThresholdSeconds: 1800, rows };
}
