/**
 * Five plain tags for a job that ended EMPTY (RQ-EMPTYWHYN21IQ8). Maps the final-output verdict of
 * empty-final-reason.ts onto the tags the fleet reads: already_done, pool_cap, blocked,
 * no_change_needed, unknown. Pure: callers read the log. Tags are fixed words, never log text.
 */
import { classifyFinalEmpty, type FinalEmptyReason, type FinalEmptyVerdict } from './empty-final-reason.js';

export const EMPTY_TAGS = ['already_done', 'pool_cap', 'blocked', 'no_change_needed', 'unknown'] as const;
export type EmptyTag = (typeof EMPTY_TAGS)[number];
export const EMPTY_TAGS_SCHEMA = 'jobs.empty-tags.v1';
/** Above this share of finished jobs, the digest names the top reason. */
export const EMPTY_RATE_ALERT = 0.15;

const TAG: Record<FinalEmptyReason, EmptyTag> = {
  'already-shipped': 'already_done', 'usage-out': 'pool_cap', 'no-change-needed': 'no_change_needed',
  'repo-rule': 'blocked', 'blocked-dependency': 'blocked', 'tool-missing': 'blocked',
  // A timeout is not a statement about the work; leave it unknown rather than guess.
  timeout: 'unknown', unknown: 'unknown',
};

export const EMPTY_TAG_LABELS: Record<EmptyTag, string> = {
  already_done: 'already on master or a duplicate', pool_cap: 'model limit or quota', blocked: 'missing file, tool or permission',
  no_change_needed: 'no change needed', unknown: 'unknown',
};

export const tagForReason = (reason: FinalEmptyReason): EmptyTag => TAG[reason];

/** Tag a finished job from the end of its log. A missing log is `unknown`. */
export function tagEmpty(log: string | null): { tag: EmptyTag; sentence: string | null } {
  const verdict: FinalEmptyVerdict = classifyFinalEmpty(log);
  return { tag: TAG[verdict.reason], sentence: verdict.sentence };
}

export interface TaggedEmptyJob { id: string; lane: string; tag: EmptyTag }
export interface EmptyTagExample { id: string; lane: string }
export interface EmptyTagsReport {
  schema: typeof EMPTY_TAGS_SCHEMA;
  /** Jobs that finished in the window, empty or not; null when the ledger gave no finishes. */
  finished: number;
  empty: number;
  /** empty / finished, 0 to 1; null when nothing finished. */
  rate: number | null;
  counts: Record<EmptyTag, number>;
  top: EmptyTag | null;
  lanes: { lane: string; empty: number; counts: Record<EmptyTag, number> }[];
  /** The newest job per tag; tags with no job are omitted. */
  examples: Partial<Record<EmptyTag, EmptyTagExample>>;
}

const zero = (): Record<EmptyTag, number> => Object.fromEntries(EMPTY_TAGS.map(t => [t, 0])) as Record<EmptyTag, number>;

/** `jobs` oldest first (ledger order). Ties for the top tag go to a named cause over unknown. */
export function summarizeEmptyTags(jobs: readonly TaggedEmptyJob[], finished: number): EmptyTagsReport {
  const counts = zero();
  const byLane = new Map<string, Record<EmptyTag, number>>();
  const examples: EmptyTagsReport['examples'] = {};
  for (const job of [...jobs].reverse()) {
    counts[job.tag]++;
    const lane = byLane.get(job.lane) ?? zero();
    lane[job.tag]++;
    byLane.set(job.lane, lane);
    examples[job.tag] ??= { id: job.id, lane: job.lane };
  }
  const total = Math.max(finished, jobs.length);
  const top = jobs.length ? [...EMPTY_TAGS].sort((a, b) => counts[b] - counts[a])[0]! : null;
  return {
    schema: EMPTY_TAGS_SCHEMA, finished: total, empty: jobs.length, rate: total ? jobs.length / total : null, counts, top, examples,
    lanes: [...byLane].map(([lane, c]) => ({ lane, counts: c, empty: Object.values(c).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.empty - a.empty || a.lane.localeCompare(b.lane)),
  };
}

/** One plain sentence for the digest, or null when the empty rate is at or under the alert line. */
export function emptyDigestLine(report: EmptyTagsReport): string | null {
  if (report.rate === null || report.rate <= EMPTY_RATE_ALERT || !report.top) return null;
  return `${Math.round(report.rate * 100)}% of jobs ended empty; top reason: ${EMPTY_TAG_LABELS[report.top]} (${report.counts[report.top]} of ${report.empty}).`;
}

/** Plain text lines for the CLI. `by` picks the grouping. */
export function formatEmptyTags(report: EmptyTagsReport, by: 'reason' | 'lane', hours: number): string[] {
  if (report.empty === 0) return ['No empty jobs.'];
  const pct = report.rate === null ? '' : ` (${Math.round(report.rate * 100)}% of ${report.finished})`;
  const lines = [`${report.empty} empty jobs in the last ${hours} hours${pct}`];
  if (by === 'lane') {
    for (const row of report.lanes) lines.push(`${row.lane}: ${row.empty} empty; ${EMPTY_TAGS.filter(t => row.counts[t]).map(t => `${t} ${row.counts[t]}`).join(', ')}`);
    return lines;
  }
  for (const tag of [...EMPTY_TAGS].sort((a, b) => report.counts[b] - report.counts[a])) {
    if (!report.counts[tag]) continue;
    const ex = report.examples[tag];
    lines.push(`${tag}: ${report.counts[tag]} (${EMPTY_TAG_LABELS[tag]})${ex ? `; newest ${ex.id} on ${ex.lane}` : ''}`);
  }
  return lines;
}

/**
 * `--record`: append one row per tagged job to `<runs>/metrics/empty-tags.jsonl`, skipping jobs already
 * there, so the tag lives beside the job's ledger rows. Never creates the metrics directory.
 */
export async function recordEmptyTags(runsDir: string, jobs: readonly TaggedEmptyJob[]): Promise<number> {
  const { readFile, appendFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const file = join(runsDir, 'metrics', 'empty-tags.jsonl');
  const seen = new Set<string>();
  for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
    try { const row = JSON.parse(line) as { job?: unknown }; if (typeof row.job === 'string') seen.add(row.job); } catch { /* skip a torn line */ }
  }
  const fresh = jobs.filter(job => !seen.has(job.id));
  if (fresh.length) await appendFile(file, fresh.map(job => `${JSON.stringify({ schema: 'job.empty-tag.v1', job: job.id, lane: job.lane, tag: job.tag })}\n`).join(''));
  return fresh.length;
}
