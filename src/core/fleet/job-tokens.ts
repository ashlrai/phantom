/**
 * Token use per job lane. Codex finish rows already carry `tokens_total`; Claude Code jobs do not, so
 * their usage is read from the final `result` object in the job log (`--output-format json` or
 * `stream-json`). A job with no usage object is unmeasured (null), never zero.
 */
import { join } from 'node:path';
import { readText } from './empty-cause.js';
import { yieldTally, type YieldRun } from './slot-yield.js';

export const JOB_TOKENS_SCHEMA = 'jobs.tokens.v1';
/** Log tail read per job; the result object is the last line. */
const LOG_TAIL_BYTES = 1_048_576;

export interface ClaudeUsage {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
  /** Sum of the four counts above. */
  total_tokens: number;
  total_cost_usd: number | null;
}

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function fromResult(value: unknown): ClaudeUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const usage = row.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
  // A usage object with none of the counts says nothing: unmeasured.
  if (!keys.some(key => typeof u[key] === 'number')) return null;
  const [input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens] = keys.map(key => num(u[key])) as [number, number, number, number];
  const cost = row.total_cost_usd;
  return {
    input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
    total_tokens: input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens,
    total_cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

const isResult = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'result';

/** The usage of the last `result` object in a Claude Code log; null when there is none. */
export function parseClaudeUsage(text: string): ClaudeUsage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // `--output-format json`: one object, or (newer builds) an array of events.
  try {
    const whole: unknown = JSON.parse(trimmed);
    if (Array.isArray(whole)) {
      for (let i = whole.length - 1; i >= 0; i--) if (isResult(whole[i])) return fromResult(whole[i]);
      return null;
    }
    return isResult(whole) ? fromResult(whole) : null;
  } catch { /* stream-json: one object per line, maybe with other text around it */ }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isResult(value)) return fromResult(value);
    } catch { /* not a JSON line */ }
  }
  return null;
}

export interface JobsTokens {
  schema: typeof JOB_TOKENS_SCHEMA; version: 1; lane: string; window_hours: number; known: boolean;
  /** Finished jobs in the window. */
  jobs: number;
  /** Jobs whose token use is known, from the finish row or the job log. */
  measured: number;
  /** measured / jobs; null when there are no jobs. */
  coverage: number | null;
  /** Sum over measured jobs; null when none is measured (unknown, not zero). */
  tokens_total: number | null;
  /** Spend reported by Claude Code logs, over the jobs that reported it. */
  cost_usd: number | null;
  /** Merged jobs, and how many of them are measured. */
  merged: number; merged_measured: number;
  /** Tokens of measured jobs per merged job among them; null until a measured job has merged. */
  tokens_per_merged_pr: number | null;
}

const unknownTokens = (lane: string, hours: number): JobsTokens => ({
  schema: JOB_TOKENS_SCHEMA, version: 1, lane, window_hours: hours, known: false, jobs: 0, measured: 0, coverage: null,
  tokens_total: null, cost_usd: null, merged: 0, merged_measured: 0, tokens_per_merged_pr: null,
});

/**
 * Fold ledger lines into one lane's token report. A run without `tokens_total` on its finish row
 * falls back to `<root>/<job>.log`. `root` is the fleet runs dir.
 */
export async function buildJobsTokens(lines: Iterable<string>, root: string, lane: string, hours: number, now: number, read: (path: string, max: number) => Promise<string | null> = readText): Promise<JobsTokens> {
  const tally = yieldTally(now, hours);
  for (const line of lines) tally.add(line);
  const runs: YieldRun[] = tally.runs().filter(run => run.lane === lane && run.finished);
  const usage = new Map<YieldRun, ClaudeUsage | null>();
  for (let i = 0; i < runs.length; i += 16) {
    await Promise.all(runs.slice(i, i + 16).filter(run => run.tokens === null).map(async run => {
      const log = await read(join(root, `${run.job}.log`), LOG_TAIL_BYTES).catch(() => null);
      usage.set(run, log === null ? null : parseClaudeUsage(log));
    }));
  }
  const report = unknownTokens(lane, hours);
  report.known = true;
  report.jobs = runs.length;
  let tokens = 0, cost = 0, costed = 0;
  for (const run of runs) {
    const found = usage.get(run) ?? null;
    const total = run.tokens ?? found?.total_tokens ?? null;
    if (run.merged) report.merged++;
    if (total === null) continue;
    report.measured++; tokens += total;
    if (run.merged) report.merged_measured++;
    if (found?.total_cost_usd != null) { cost += found.total_cost_usd; costed++; }
  }
  report.coverage = runs.length ? report.measured / runs.length : null;
  report.tokens_total = report.measured ? tokens : null;
  report.cost_usd = costed ? Math.round(cost * 1e6) / 1e6 : null;
  if (report.merged_measured) {
    // Tokens of measured merged jobs only, so an unmeasured merge never lowers the average.
    let mergedTokens = 0;
    for (const run of runs) if (run.merged) mergedTokens += run.tokens ?? usage.get(run)?.total_tokens ?? 0;
    report.tokens_per_merged_pr = mergedTokens / report.merged_measured;
  }
  return report;
}

export function jobsTokensLines(report: JobsTokens): string[] {
  if (!report.known) return ['Tokens: unknown (job metrics file unreadable)'];
  const pct = report.coverage === null ? 'unknown' : `${Math.round(report.coverage * 100)}%`;
  return [
    `${report.lane}: ${report.jobs} jobs in the last ${report.window_hours} hours, ${report.measured} measured (${pct})`,
    report.tokens_total === null ? 'Tokens: unknown (no job reported usage)' : `Tokens: ${report.tokens_total}`,
    report.tokens_per_merged_pr === null ? 'Tokens per merged PR: unknown' : `Tokens per merged PR: ${Math.round(report.tokens_per_merged_pr)}`,
  ];
}
