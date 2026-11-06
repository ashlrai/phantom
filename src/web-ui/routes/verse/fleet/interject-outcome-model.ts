import { githubUrl, jobsForEntry, stateWord, type OrderTraceJob, type OrderTraceV1 } from '../fleet-inbox/order-trace-model.js';

export interface InterjectOutcome {
  stage: 'sent' | 'acked' | 'job' | 'merged' | 'unknown';
  text: string;
  href?: string;
}

const PR_PATH = /^\/ashlrai\/phantom\/pull\/(\d+)\/?$/;
const JOB_RANK: Record<OrderTraceJob['state'], number> = { queued: 0, launched: 1, published: 2, merged: 3 };

function prNumber(job: OrderTraceJob): string | null {
  const url = githubUrl(job);
  return url ? PR_PATH.exec(new URL(url).pathname)?.[1] ?? null : null;
}

/**
 * Outcome of one inbox entry. Matching is `jobsForEntry` (entry heading or
 * timestamp key), the same rule the Inbox pane uses; the most advanced stage wins.
 */
export function interjectOutcome(entryAt: string, acked: boolean, trace: OrderTraceV1 | null): InterjectOutcome {
  const jobs = jobsForEntry(trace, entryAt);
  const merged = jobs.filter(job => job.state === 'merged');
  if (merged.length) {
    const job = merged.find(candidate => prNumber(candidate)) ?? merged[0]!;
    const number = prNumber(job);
    return number ? { stage: 'merged', text: `merged #${number}`, href: `https://github.com/ashlrai/phantom/pull/${number}` }
      : { stage: 'merged', text: 'merged' };
  }
  if (jobs.length) {
    const job = jobs.reduce((best, next) => JOB_RANK[next.state] > JOB_RANK[best.state] ? next : best);
    return { stage: 'job', text: `job ${job.id} ${stateWord(job)}` };
  }
  if (entryAt === '—') return { stage: 'unknown', text: 'outcome unknown' };
  return acked ? { stage: 'acked', text: 'acked' } : { stage: 'sent', text: 'sent' };
}
