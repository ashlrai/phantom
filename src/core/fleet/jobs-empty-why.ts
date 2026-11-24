import { join } from 'node:path';
import { classifyEmpty } from './empty-jobs.js';
import { classifyEmptyReason, finishesIn, type EmptiesFinish } from './empties.js';
import { ledgerRows, readText } from './empty-cause.js';
import { emptyJobCause, emptyJobGenerator, type EmptyJobCause } from './empty-job-origin.js';
import { detectPoolCap, diagnoseEmptyJob, FLEET_EMPTY_WHY_LOG_LINES } from './empty-why-classify.js';
import { jobKind } from './slot-yield.js';
import { scrubSecrets } from '../util/scrub.js';

export const JOB_EMPTY_REASONS = ['pool-cap', 'no-diff', 'already-on-main', 'precheck-catchable', 'tool-error', 'unknown'] as const;
export type JobEmptyReason = typeof JOB_EMPTY_REASONS[number];
interface EmptyWhyJob { id: string; family: string; lane: string; generator: string; cause: EmptyJobCause; reason: JobEmptyReason; tokens: number | null }
export interface EmptyWhyOptions { lane?: string; last?: number }
export interface JobsEmptyWhy {
  schema: 'jobs.empty-why.v1'; version: 1; window_hours: number; known: boolean;
  total: number | null; jobs: EmptyWhyJob[];
  lane: string | null; last: number | null; sampled: number | null; verdict: string;
  generators: { generator: string; empty: number }[];
  families: { family: string; empty: number; wasted_tokens: number | null; tokens_unknown_jobs: number; reasons: Record<JobEmptyReason, number> }[];
}

function reason(finish: EmptiesFinish, log: string | null, publish: string | null): JobEmptyReason {
  log = log?.split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n') ?? null;
  publish = publish?.split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n') ?? null;
  if (detectPoolCap(log) || detectPoolCap(publish)) return 'pool-cap';
  const diagnosis = diagnoseEmptyJob(log, publish);
  const result = classifyEmpty(publish, log, finish);
  if (result.outcome === 'failed' || ['tool error', 'sandbox or permission denial', 'provider quota or rate limit', 'timed out', 'test or typecheck failed and was reverted'].includes(diagnosis)) return 'tool-error';
  if (diagnosis === 'already-on-master') return 'already-on-main';
  const cause = classifyEmptyReason(finish, { log, notes: publish, timedOut: false });
  if (result.outcome === 'duplicate' || result.outcome === 'already-implemented' || ['no_eligible_target', 'precheck_skip'].includes(cause)) return 'precheck-catchable';
  // Exit zero alone proves no cause. Require explicit no-change evidence.
  return cause === 'no_diff' || diagnosis === 'no-op change' ? 'no-diff' : 'unknown';
}

/** Newest finish per job, matching the existing empties reader; actual precheck skips spent no launch. */
export async function readJobsEmptyWhy(ledger: string | null, root: string, hours: number, now: number, read = readText, options: EmptyWhyOptions = {}): Promise<JobsEmptyWhy> {
  const report: JobsEmptyWhy = { schema: 'jobs.empty-why.v1', version: 1, window_hours: hours, known: ledger !== null, total: ledger === null ? null : 0, jobs: [], families: [],
    lane: options.lane ?? null, last: options.last ?? null, sampled: ledger === null ? null : 0, generators: [], verdict: 'Empty reasons: unknown (job metrics file unreadable)' };
  const selected = (ledger === null ? [] : finishesIn(ledgerRows(ledger, now, hours).rows)).filter(job => !job.skipped && (!options.lane || job.lane === options.lane)).sort((a, b) => a.at - b.at).slice(options.last ? -options.last : 0);
  if (report.known) report.sampled = selected.length;
  const finishes = selected.filter(job => job.empty);
  for (let i = 0; i < finishes.length; i += 16) {
    report.jobs.push(...await Promise.all(finishes.slice(i, i + 16).map(async finish => {
      const [log, publish] = await Promise.all(['log', 'publish'].map(ext => read(join(root, `${finish.id}.${ext}`), 65536).catch(() => null)));
      return { id: scrubSecrets(finish.id), family: scrubSecrets(jobKind(finish.id)), lane: scrubSecrets(finish.lane), generator: emptyJobGenerator(finish.id), cause: emptyJobCause(log, publish), reason: reason(finish, log, publish), tokens: finish.tokens };
    })));
  }
  if (report.known) report.total = report.jobs.length;
  const groups = new Map<string, JobsEmptyWhy['families'][number]>();
  for (const job of report.jobs) {
    const row = groups.get(job.family) ?? { family: job.family, empty: 0, wasted_tokens: null, tokens_unknown_jobs: 0,
      reasons: Object.fromEntries(JOB_EMPTY_REASONS.map(key => [key, 0])) as Record<JobEmptyReason, number> };
    row.empty++; row.reasons[job.reason]++;
    if (job.tokens === null) row.tokens_unknown_jobs++; else row.wasted_tokens = (row.wasted_tokens ?? 0) + job.tokens;
    groups.set(job.family, row);
  }
  report.families = [...groups.values()].sort((a, b) => (b.wasted_tokens ?? -1) - (a.wasted_tokens ?? -1) || a.family.localeCompare(b.family));
  const counts = new Map<string, number>(), causes = new Map<string, number>();
  for (const job of report.jobs) {
    counts.set(job.generator, (counts.get(job.generator) ?? 0) + 1);
    const pair = `${job.cause} from ${job.generator}`;
    causes.set(pair, (causes.get(pair) ?? 0) + 1);
  }
  report.generators = [...counts].map(([generator, empty]) => ({ generator, empty })).sort((a, b) => b.empty - a.empty || a.generator.localeCompare(b.generator));
  const top = [...causes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (report.known) report.verdict = `${scrubSecrets(options.lane ?? 'all lanes')}: ${report.total} of ${report.sampled} empty${top ? `; top cause ${top[0]} (${top[1]})` : ''}`;
  return report;
}

export function emptyWhyLines(report: JobsEmptyWhy): string[] {
  if (!report.known) return ['Empty reasons: unknown (job metrics file unreadable)'];
  return [`${report.total} empty jobs in the last ${report.window_hours} hours; families ranked by recorded wasted tokens`,
    ...report.families.map(row => `${row.family}: ${row.wasted_tokens ?? 'unknown'} wasted tokens; ${row.tokens_unknown_jobs} jobs with unknown tokens; ${Object.entries(row.reasons).filter(([, n]) => n).map(([key, n]) => `${n} ${key}`).join(', ')}`),
    'Job\tLane\tGenerator (inferred from id)\tCause', ...report.jobs.map(j => `${j.id}\t${j.lane}\t${j.generator}\t${j.cause}`),
    ...report.generators.map(g => `${g.generator}: ${g.empty} empty slots`), report.verdict];
}
