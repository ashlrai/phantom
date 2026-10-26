/** Local adapter contract until RQ-METRICS-ROUTER-FEED is integrated. */
export interface RouterJob {
  jobId: string;
  outcome: 'merged' | 'empty' | 'incomplete' | 'failed' | 'pending';
  tokens?: number;
  /** Receipt from the shared impact scorer, not a locally estimated weight. */
  impact?: { score: number; version: string };
}

export interface RouterFeed {
  schemaVersion: 1;
  available: boolean;
  jobs: RouterJob[];
}

export function readRouterFeed(): RouterFeed {
  return { schemaVersion: 1, available: false, jobs: [] };
}

export function parseRouterFeed(value: unknown): RouterFeed {
  if (!value || typeof value !== 'object') throw new Error('Invalid router feed');
  const feed = value as Partial<RouterFeed>;
  if (feed.schemaVersion !== 1 || typeof feed.available !== 'boolean' || !Array.isArray(feed.jobs)) {
    throw new Error('Expected router feed schemaVersion 1, available and jobs');
  }
  const seen = new Set<string>();
  for (const job of feed.jobs) {
    if (!job || typeof job.jobId !== 'string' || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(job.jobId) ||
        seen.has(job.jobId) || !['merged', 'empty', 'incomplete', 'failed', 'pending'].includes(job.outcome)) {
      throw new Error('Invalid or duplicate router job');
    }
    seen.add(job.jobId);
    if (job.tokens !== undefined && (!Number.isSafeInteger(job.tokens) || job.tokens < 0)) {
      throw new Error('Invalid token observation');
    }
    if (job.impact !== undefined && (!job.impact || !Number.isFinite(job.impact.score) ||
        job.impact.score < 0 || typeof job.impact.version !== 'string' || !job.impact.version.trim())) {
      throw new Error('Invalid shared impact receipt');
    }
  }
  if (!feed.available && feed.jobs.length) throw new Error('Unavailable feed must have no jobs');
  return feed as RouterFeed;
}
