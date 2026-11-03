import { isFailedJob } from './replay.js';
import type { QueueDocument, QueueJob } from './schema.js';
import type { QueueStore } from './store.js';

export interface IssueGroup {
  /** Normalized error text: ids, timestamps and long numbers replaced by placeholders. */
  error: string;
  count: number;
  /** Up to SAMPLE_LIMIT job ids, sorted. */
  samples: string[];
  /** Every failed job id in the group, sorted. */
  jobs: string[];
}
export interface IssueReport { v: 1; failed: number; groups: IssueGroup[] }
export interface IssueRetry { v: 1; retried: Array<{ id: string; retry: string }> }

const SAMPLE_LIMIT = 3;
const NO_TEXT = '(no error text)';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Collapse one failure message so repeats of the same problem compare equal. */
export function normalizeError(text: string | undefined, ownId?: string): string {
  let out = text ?? '';
  if (ownId) out = out.replace(new RegExp(escapeRegExp(ownId), 'g'), '<id>');
  out = out
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/g, '<time>')
    .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\bRQ-[A-Za-z0-9][A-Za-z0-9._-]*/g, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, '<id>')
    .replace(/#\d+\b/g, '#<n>')
    .replace(/\b\d{5,}\b/g, '<n>');
  out = out.replace(/\s+/g, ' ').trim().toLowerCase();
  return out || NO_TEXT;
}

/** Group failed jobs by normalized error, biggest group first. Pure and read-only. */
export function groupIssues(doc: QueueDocument): IssueReport {
  const byError = new Map<string, string[]>();
  const failed = doc.jobs.filter(isFailedJob);
  for (const job of failed) {
    const key = normalizeError(job.blockedReason, job.id);
    byError.set(key, [...(byError.get(key) ?? []), job.id]);
  }
  const groups = [...byError].map(([error, ids]): IssueGroup => {
    const jobs = ids.sort();
    return { error, count: jobs.length, samples: jobs.slice(0, SAMPLE_LIMIT), jobs };
  }).sort((a, b) => b.count - a.count || a.error.localeCompare(b.error));
  return { v: 1, failed: failed.length, groups };
}

/** Write one READY retry per failed job. Repeats reuse a retry that is still active. */
export async function retryIssues(store: QueueStore): Promise<IssueRetry> {
  const ids = groupIssues(await store.read()).groups.flatMap(group => group.jobs);
  const jobs: QueueJob[] = ids.length ? await store.replay({ ids }) : [];
  return { v: 1, retried: jobs.map(job => ({ id: job.replayOf!, retry: job.id })) };
}
