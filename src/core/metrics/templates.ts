import type { RouterFeed, RouterJob } from './router-feed.js';

export const MIN_TEMPLATE_JOBS = 5;

export function templateFamily(jobId: string): string {
  const parts = jobId.split('-');
  return `${parts.slice(0, parts[0] === 'RQ' || parts[0] === 'LAND' ? 2 : 1).join('-')}-*`;
}

/** Pure aggregation. Pending work never becomes a failure or a completed sample. */
export function rankTemplates(feed: RouterFeed) {
  const groups = new Map<string, RouterFeed['jobs']>();
  for (const job of feed.jobs) {
    const family = templateFamily(job.jobId);
    const jobs = groups.get(family) ?? [];
    jobs.push(job);
    groups.set(family, jobs);
  }
  const templates = [...groups].map(([template, jobs]) => {
    const completed = [...jobs].sort((a, b) => a.jobId.localeCompare(b.jobId)).filter(job => job.outcome !== 'pending');
    const merged = completed.filter(job => job.outcome === 'merged');
    const empty = completed.filter(job => job.outcome === 'empty').length;
    const incomplete = completed.filter(job => job.outcome === 'incomplete').length;
    const eligible = completed.length >= MIN_TEMPLATE_JOBS;
    const versions = new Set(merged.map(job => job.impact?.version));
    const impactComplete = completed.length > 0 && completed.every(job => job.tokens !== undefined) &&
      merged.every(job => job.impact !== undefined) && versions.size <= 1;
    const tokens = impactComplete ? completed.reduce((sum, job) => sum + job.tokens!, 0) : null;
    const mergedImpact = impactComplete ? merged.reduce((sum, job) => sum + job.impact!.score, 0) : null;
    const emptyRate = completed.length ? empty / completed.length : null;
    const incompleteRate = completed.length ? incomplete / completed.length : null;
    return {
      template, jobs: jobs.length, completed: completed.length, pending: jobs.length - completed.length,
      merged: merged.length, empty, incomplete,
      mergeRate: completed.length ? merged.length / completed.length : null,
      emptyRate, incompleteRate,
      emptyOrIncompleteRate: completed.length ? (empty + incomplete) / completed.length : null,
      eligible, recommendation: !eligible ? 'insufficient-sample' :
        emptyRate! > 0.3 ? 'retire-or-rewrite' : (empty + incomplete) / completed.length > 0.3 ? 'rewrite' : 'keep',
      tokens, mergedImpact, impactVersion: impactComplete && merged.length ? merged[0].impact!.version : null,
      mergedImpactPerMillionTokens: eligible && tokens && Number.isFinite(tokens) && mergedImpact !== null && Number.isFinite(mergedImpact) ? mergedImpact / tokens * 1_000_000 : null,
    };
  });
  const ranked = (compare: (a: typeof templates[number], b: typeof templates[number]) => number) =>
    templates.filter(row => row.eligible).sort((a, b) => compare(a, b) || a.template.localeCompare(b.template)).map(row => row.template);
  const impactVersions = new Set(templates.filter(row => row.eligible && row.impactVersion !== null).map(row => row.impactVersion));
  return {
    schemaVersion: 1, source: feed.available ? 'available' : 'unavailable',
    minimumCompletedJobs: MIN_TEMPLATE_JOBS, retireEmptyRateAbove: 0.3,
    templates: templates.sort((a, b) => a.template.localeCompare(b.template)),
    rankings: {
      mergedImpactPerToken: impactVersions.size > 1 ? [] : ranked((a, b) => (b.mergedImpactPerMillionTokens ?? -1) - (a.mergedImpactPerMillionTokens ?? -1))
        .filter(name => templates.find(row => row.template === name)!.mergedImpactPerMillionTokens !== null),
      mergeRate: ranked((a, b) => b.mergeRate! - a.mergeRate!),
      emptyOrIncompleteRate: ranked((a, b) => b.emptyOrIncompleteRate! - a.emptyOrIncompleteRate!),
    },
  };
}
