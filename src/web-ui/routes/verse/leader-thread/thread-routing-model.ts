/**
 * routes/verse/leader-thread/thread-routing-model.ts — where one of Mason's
 * messages went. The order trace (`/api/verse/leader/orders`, the read behind
 * `phm fleet orders --json`) already ties each MASON-INBOX entry to the jobs
 * whose prompts cite it, with the lane each job was routed to and how far it
 * got. This module looks that up for a Leader-thread line and words it. It
 * never invents a route: a message no job cites reads "not routed yet", and
 * when the prompt journals could not be read the answer is "unknown". Pure;
 * the tests feed the shapes.
 */
import { githubUrl, jobsForEntry, stateWord, type OrderTraceJob, type OrderTraceV1 } from '../fleet-inbox/order-trace-model.js';
import { validJob } from '../fleet/workers-card-model.js';

/** A message older than this with no job stays quiet: it was conversation, not an order still waiting. */
export const UNROUTED_WINDOW_MS = 6 * 60 * 60_000;

/** The four recorded stages of a job, in order; `ROUTING_STAGES.indexOf(state)` is how far it got. */
export const ROUTING_STAGES = ['queued', 'launched', 'published', 'merged'] as const;

export interface RoutedJob {
  id: string;
  /** The lane the launch marker or the ready queue names; null when neither does. */
  lane: string | null;
  state: OrderTraceJob['state'];
  /** Stages reached, 1 to 4. */
  reached: number;
  /** The job ended with nothing to publish. */
  empty: boolean;
  /** "queued", "launched", "PR #12", "merged #12" or "ended empty". */
  word: string;
  /** The job's GitHub link when the trace holds a safe one. */
  href: string | null;
  /** A launched job has a worker log to open; a queued one does not. */
  openable: boolean;
}

export type LineRouting =
  | { state: 'routed'; jobs: RoutedJob[]; summary: string }
  | { state: 'unrouted' | 'unknown'; jobs: []; summary: string };

/** What the lookup needs of a thread line. */
export interface RoutingLine { id: string; who: 'mason' | 'leader'; source: string; text: string }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The MASON-INBOX heading a thread line stands for, or null when the line is
 * not an inbox order. An inbox row carries its own index in its id; a relayed
 * thread post is matched the way the merge attributes its ack, by text that
 * identifies exactly one inbox row.
 */
export function inboxAtForLine(line: RoutingLine, inbox: readonly { at: string; text: string }[]): string | null {
  if (line.who !== 'mason' || line.source === 'system') return null;
  const index = /^inbox-(\d+)$/.exec(line.id)?.[1];
  if (index !== undefined) return inbox[Number(index)]?.at ?? null;
  if (/^(?:owner|composer|lane)-/.test(line.id)) return null;
  const matches = inbox.filter(entry => entry.text.trim() === line.text.trim());
  return matches.length === 1 ? matches[0]!.at : null;
}

function routedJob(job: OrderTraceJob): RoutedJob {
  const empty = job.endedEmptyAt !== undefined && job.state !== 'published' && job.state !== 'merged';
  return {
    id: job.id,
    lane: job.lane,
    state: job.state,
    reached: ROUTING_STAGES.indexOf(job.state) + 1,
    empty,
    word: empty ? 'ended empty' : stateWord(job),
    href: githubUrl(job),
    openable: job.state !== 'queued' && validJob(job.id),
  };
}

/** "3 jobs · 2 lanes · 1 merged · 2 launched": counts only, furthest stage first. */
export function routingSummary(jobs: readonly RoutedJob[]): string {
  const lanes = new Set(jobs.flatMap(job => (job.lane === null ? [] : [job.lane])));
  const parts = [plural(jobs.length, 'job')];
  if (lanes.size) parts.push(plural(lanes.size, 'lane'));
  const empty = jobs.filter(job => job.empty).length;
  for (const stage of [...ROUTING_STAGES].reverse()) {
    const count = jobs.filter(job => job.state === stage && !job.empty).length;
    if (count) parts.push(`${count} ${stage}`);
  }
  if (empty) parts.push(`${empty} ended empty`);
  return parts.join(' · ');
}

/**
 * Routing for one inbox heading. Null means "say nothing": no trace, an
 * entry the trace does not hold, or an old message that never became work.
 * `skipJob` drops the job a steer order aimed at, which has its own line.
 */
export function lineRouting(trace: OrderTraceV1 | null, entryAt: string | null, opts: { lineAtMs: number; nowMs: number; skipJob?: string | null; quiet?: boolean }): LineRouting | null {
  if (!trace || entryAt === null) return null;
  const jobs = jobsForEntry(trace, entryAt).filter(job => job.id !== opts.skipJob).map(routedJob);
  if (jobs.length) return { state: 'routed', jobs, summary: routingSummary(jobs) };
  // Same two-step match as jobsForEntry: the exact heading, then its MM-DD HH:MM key.
  const key = /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2})(?: ET)?$/.exec(entryAt)?.[1];
  const known = trace.orders.some(order => order.at === entryAt || (key !== undefined && order.key === key));
  const fresh = Number.isFinite(opts.lineAtMs) && opts.nowMs - opts.lineAtMs <= UNROUTED_WINDOW_MS;
  if (!known || !fresh || opts.quiet || opts.skipJob) return null;
  return trace.sources.prompts === 'healthy'
    ? { state: 'unrouted', jobs: [], summary: 'Not routed to a lane yet' }
    : { state: 'unknown', jobs: [], summary: 'Routing unknown: job prompts could not be read' };
}

/** Jobs still moving (not merged, not ended empty) across the given routings, each counted once. */
export function routingInFlight(routings: readonly (LineRouting | null)[]): number {
  const ids = new Set<string>();
  for (const routing of routings) {
    if (routing?.state !== 'routed') continue;
    for (const job of routing.jobs) if (job.state !== 'merged' && !job.empty) ids.add(job.id);
  }
  return ids.size;
}
