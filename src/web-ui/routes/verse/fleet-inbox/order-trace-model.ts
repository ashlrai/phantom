export interface OrderTraceJob {
  id: string; lane: string | null; state: 'queued' | 'launched' | 'published'; url: string | null;
}
export interface OrderTraceV1 {
  v: 1; generatedAt: string; sources: { inbox: unknown; prompts: unknown; publishes: unknown };
  orders: { at: string; source: string; key: string; jobs: OrderTraceJob[] }[];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function narrowOrderTrace(v: unknown): OrderTraceV1 | null {
  if (!record(v) || v.v !== 1 || typeof v.generatedAt !== 'string' || !record(v.sources)
    || !('inbox' in v.sources) || !('prompts' in v.sources) || !('publishes' in v.sources) || !Array.isArray(v.orders)) return null;
  const orders: OrderTraceV1['orders'] = [];
  for (const order of v.orders) {
    if (!record(order) || typeof order.at !== 'string' || typeof order.source !== 'string'
      || typeof order.key !== 'string' || !Array.isArray(order.jobs)) return null;
    const jobs: OrderTraceJob[] = [];
    for (const job of order.jobs) {
      if (!record(job) || typeof job.id !== 'string' || !job.id || !nullableString(job.lane) || !nullableString(job.url)
        || (job.state !== 'queued' && job.state !== 'launched' && job.state !== 'published')) return null;
      jobs.push({ id: job.id, lane: job.lane, state: job.state, url: job.url });
    }
    orders.push({ at: order.at, source: order.source, key: order.key, jobs });
  }
  return { v: 1, generatedAt: v.generatedAt, sources: { inbox: v.sources.inbox, prompts: v.sources.prompts, publishes: v.sources.publishes }, orders };
}

export function jobsForEntry(trace: OrderTraceV1 | null, entryAt: string): OrderTraceJob[] {
  if (!trace || entryAt === '—') return [];
  const exact = trace.orders.filter(order => order.at === entryAt);
  if (exact.length) return exact.flatMap(order => order.jobs);
  const match = /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2})(?: ET)?$/.exec(entryAt);
  return match ? trace.orders.filter(order => order.key === match[1]).flatMap(order => order.jobs) : [];
}

export function orderJobsLine(jobs: readonly OrderTraceJob[]): string {
  return jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}` : '';
}

export function githubUrl(job: OrderTraceJob): string | null {
  if (!job.url) return null;
  try {
    const url = new URL(job.url);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function stateWord(job: OrderTraceJob): string {
  if (job.state === 'queued') return 'queued';
  if (job.state === 'launched') return 'running';
  const url = githubUrl(job);
  const number = url && /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(new URL(url).pathname)?.[1];
  return number ? `PR #${number}` : 'published';
}
