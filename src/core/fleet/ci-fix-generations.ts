/**
 * Retry generations for CI stabilization queue rows.
 *
 * `RQ-CIBASE-*` master fixes and `RQ-CIFLAKE-*` flake stabilizations are
 * queued once per (repository, test) evidence key. Plain id deduplication
 * treats a DONE row the same as a READY one, so a fix that shipped without
 * stopping the failure — the strongest self-improvement signal the CI loop
 * produces — could never be retried. This module replaces substring dedup
 * with queue-state-aware generations: a family re-queues only while every
 * recorded generation ended DONE, the newest evidence still shows the
 * condition, and the generation cap has not been reached.
 *
 * Family membership is the base id plus `-G<n>` suffixed retries
 * (`RQ-CIFLAKE-…`, `RQ-CIFLAKE-…-G2`, …). Open rows (READY through LAND)
 * suppress queueing because work is in flight; RETIRED and DROPPED rows
 * suppress it because they record an explicit stop (`phm queue` marks
 * dropped rows precisely so restockers do not re-queue them). A job-shaped
 * line that fails to parse but mentions the base id is unknown evidence and
 * also suppresses queueing rather than risking a duplicate. An unparseable
 * queue file falls back to the previous substring rule: present means
 * suppress, absent means generation 1.
 */
import { importMarkdown } from '../queue/markdown.js';
import type { QueueStatus } from '../queue/schema.js';

/** Total attempts (generations) allowed per stabilization family. */
export const MAX_FIX_GENERATIONS = 3;

const TERMINAL: ReadonlySet<QueueStatus> = new Set(['DONE', 'RETIRED', 'DROPPED']);
const STOP_STATUSES: ReadonlySet<QueueStatus> = new Set(['RETIRED', 'DROPPED']);

export interface FixGeneration {
  /** The job id to queue: the base id for generation 1, `-G<n>` after. */
  jobId: string;
  /** 1-based attempt number within the family. */
  generation: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const generationPattern = (baseJobId: string): RegExp => new RegExp(`^${escapeRegExp(baseJobId)}-G([1-9]\\d*)$`);

function generationOf(jobId: string, baseJobId: string, pattern: RegExp): number | null {
  if (jobId === baseJobId) return 1;
  const match = jobId.match(pattern);
  return match ? Number(match[1]) : null;
}

/**
 * Resolve the next queue job id for a stabilization family, or null when
 * queueing must stay suppressed. `queueText` is the current queue file
 * contents (possibly empty or absent-file equivalent). Generations beyond
 * `opts.maxGenerations` are suppressed; the default is MAX_FIX_GENERATIONS.
 */
export function nextFixGeneration(queueText: string, baseJobId: string, opts: { maxGenerations?: number } = {}): FixGeneration | null {
  const maxGenerations = opts.maxGenerations ?? MAX_FIX_GENERATIONS;
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1) throw new RangeError('maxGenerations must be a positive safe integer');
  let doc: ReturnType<typeof importMarkdown> | null = null;
  try {
    doc = importMarkdown(queueText);
  } catch {
    doc = null;
  }
  if (doc === null) {
    return queueText.includes(baseJobId) ? null : { jobId: baseJobId, generation: 1 };
  }
  const pattern = generationPattern(baseJobId);
  const generations: number[] = [];
  let open = false;
  let stopped = false;
  for (const job of doc.jobs) {
    const generation = generationOf(job.id, baseJobId, pattern);
    if (generation === null) continue;
    generations.push(generation);
    if (!TERMINAL.has(job.status)) open = true;
    else if (STOP_STATUSES.has(job.status)) stopped = true;
  }
  const unknown = (doc.raw ?? []).some(entry => entry.text.includes(baseJobId));
  if (open || stopped || unknown) return null;
  if (generations.length === 0) return { jobId: baseJobId, generation: 1 };
  const next = Math.max(...generations) + 1;
  if (next > maxGenerations) return null;
  return { jobId: `${baseJobId}-G${next}`, generation: next };
}
