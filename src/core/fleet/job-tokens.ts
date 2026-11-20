/**
 * Token use per job. Codex finish rows already carry `tokens_total`; otherwise usage is read from the
 * job's own log: Claude Code's final `result` object (`--output-format json` or `stream-json`) or the
 * Codex `tokens used` line. A job with no usage is unmeasured (null), never zero.
 */
import { join } from 'node:path';
import { readText } from './empty-cause.js';
import { yieldTally, type YieldRun } from './slot-yield.js';

export const JOB_TOKENS_SCHEMA = 'jobs.tokens.v1';
export const JOB_COST_SCHEMA = 'jobs.cost.v1';
/** Log tail read per job; the result object is the last line. */
const LOG_TAIL_BYTES = 1_048_576;

export interface JobUsage {
  /** Null when the agent CLI printed only a total (Codex). */
  input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null;
  /** Sum of the counts above, or the printed total. */
  total_tokens: number;
  total_cost_usd: number | null;
  /** Model named in the log; null when the log names none. */
  model: string | null;
}

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function fromResult(value: unknown): JobUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const usage = row.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
  // A usage object with none of the counts says nothing: unmeasured.
  if (!keys.some(key => typeof u[key] === 'number')) return null;
  const [input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens] = keys.map(key => num(u[key])) as [number, number, number, number];
  // `modelUsage` is keyed by model; the one that wrote the most is the job's model.
  let model: string | null = null, best = -1;
  const byModel = row.modelUsage;
  if (byModel && typeof byModel === 'object' && !Array.isArray(byModel)) {
    for (const [name, value] of Object.entries(byModel as Record<string, unknown>)) {
      const out = value && typeof value === 'object' ? num((value as Record<string, unknown>).outputTokens) : 0;
      if (out > best) { best = out; model = name.slice(0, 80); }
    }
  }
  const cost = row.total_cost_usd;
  return {
    input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
    total_tokens: input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens,
    total_cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    model,
  };
}

const isResult = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'result';

/** The usage of the last `result` object in a Claude Code log; null when there is none. */
export function parseClaudeUsage(text: string): JobUsage | null {
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

/** Codex prints `tokens used` then the total on the next line, or `tokens used: 1,234`; the last one wins. */
export function parseCodexUsage(text: string): JobUsage | null {
  let total: number | null = null;
  for (const m of text.matchAll(/^\s*tokens used(?:\s*[:=]\s*|\s*\r?\n\s*)(\d[\d,]*)\s*$/gim)) total = Number(m[1]!.replace(/,/g, ''));
  if (total === null || !Number.isSafeInteger(total)) return null;
  return { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, total_tokens: total, total_cost_usd: null, model: null };
}

/** Usage printed at the end of a finished job's log by either agent CLI; null when it printed none. */
export const parseJobUsage = (text: string): JobUsage | null => parseClaudeUsage(text) ?? parseCodexUsage(text);

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

type Reader = (path: string, max: number) => Promise<string | null>;
interface Measured { total: number | null; usage: JobUsage | null }

/** Token total per finished run: the finish row's `tokens_total`, else the usage printed in `<root>/<job>.log`. */
async function measure(runs: YieldRun[], root: string, read: Reader): Promise<Map<YieldRun, Measured>> {
  const found = new Map<YieldRun, JobUsage | null>();
  for (let i = 0; i < runs.length; i += 16) {
    await Promise.all(runs.slice(i, i + 16).filter(run => run.tokens === null).map(async run => {
      const log = await read(join(root, `${run.job}.log`), LOG_TAIL_BYTES).catch(() => null);
      found.set(run, log === null ? null : parseJobUsage(log));
    }));
  }
  return new Map(runs.map(run => { const usage = found.get(run) ?? null; return [run, { total: run.tokens ?? usage?.total_tokens ?? null, usage }]; }));
}

const finishedRuns = (lines: Iterable<string>, hours: number, now: number): YieldRun[] => {
  const tally = yieldTally(now, hours);
  for (const line of lines) tally.add(line);
  return tally.runs().filter(run => run.finished);
};

/**
 * Fold ledger lines into one lane's token report. `root` is the fleet runs dir.
 */
export async function buildJobsTokens(lines: Iterable<string>, root: string, lane: string, hours: number, now: number, read: Reader = readText): Promise<JobsTokens> {
  const runs = finishedRuns(lines, hours, now).filter(run => run.lane === lane);
  const measured = await measure(runs, root, read);
  const report = unknownTokens(lane, hours);
  report.known = true;
  const row = rollup(runs, measured);
  Object.assign(report, { jobs: row.jobs, measured: row.measured, coverage: row.coverage, tokens_total: row.tokens_total, cost_usd: row.cost_usd, merged: row.merged, merged_measured: row.merged_measured, tokens_per_merged_pr: row.tokens_per_merged_pr });
  return report;
}

export interface CostRow {
  /** Lane or model, per `by`. */
  key: string;
  jobs: number; measured: number;
  /** measured / jobs; null with no jobs. */
  coverage: number | null;
  merged: number; merged_measured: number;
  /** Null when no job in the group reported usage (unknown, not zero). */
  tokens_total: number | null;
  /** Sums over jobs that printed the split; null when none did. */
  input_tokens: number | null; output_tokens: number | null; cache_tokens: number | null;
  cost_usd: number | null;
  /** Tokens of measured merged jobs per merged job among them; null until one has merged. */
  tokens_per_merged_pr: number | null;
}

function rollup(runs: YieldRun[], measured: Map<YieldRun, Measured>): Omit<CostRow, 'key'> {
  let tokens = 0, cost = 0, costed = 0, mergedTokens = 0, mergedMeasured = 0, merged = 0, count = 0;
  const split = { input: null as number | null, output: null as number | null, cache: null as number | null };
  const add = (key: keyof typeof split, n: number | null): void => { if (n !== null) split[key] = (split[key] ?? 0) + n; };
  for (const run of runs) {
    const m = measured.get(run);
    if (run.merged) merged++;
    if (!m || m.total === null) continue;
    count++; tokens += m.total;
    if (run.merged) { mergedMeasured++; mergedTokens += m.total; }
    if (m.usage) {
      add('input', m.usage.input_tokens); add('output', m.usage.output_tokens);
      const cache = m.usage.cache_read_input_tokens === null && m.usage.cache_creation_input_tokens === null ? null : (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      add('cache', cache);
      if (m.usage.total_cost_usd !== null) { cost += m.usage.total_cost_usd; costed++; }
    }
  }
  return {
    jobs: runs.length, measured: count, coverage: runs.length ? count / runs.length : null, merged, merged_measured: mergedMeasured,
    tokens_total: count ? tokens : null, input_tokens: split.input, output_tokens: split.output, cache_tokens: split.cache,
    cost_usd: costed ? Math.round(cost * 1e6) / 1e6 : null,
    // Measured merged jobs only, so an unmeasured merge never lowers the average.
    tokens_per_merged_pr: mergedMeasured ? mergedTokens / mergedMeasured : null,
  };
}

export interface JobsCost {
  schema: typeof JOB_COST_SCHEMA; version: 1; window_hours: number; by: 'lane' | 'model'; known: boolean;
  total: CostRow;
  rows: CostRow[];
}

/** Finished jobs grouped by lane or model, with merged PRs, tokens per merged PR and coverage. */
export async function buildJobsCost(lines: Iterable<string>, root: string, hours: number, now: number, by: 'lane' | 'model' = 'lane', read: Reader = readText): Promise<JobsCost> {
  const runs = finishedRuns(lines, hours, now);
  const measured = await measure(runs, root, read);
  const keyOf = (run: YieldRun): string => by === 'lane' ? run.lane : measured.get(run)?.usage?.model ?? run.model ?? 'unknown';
  const groups = new Map<string, YieldRun[]>();
  for (const run of runs) { const key = keyOf(run); const g = groups.get(key); if (g) g.push(run); else groups.set(key, [run]); }
  const rows = [...groups].map(([key, g]) => ({ key, ...rollup(g, measured) })).sort((a, b) => b.jobs - a.jobs || a.key.localeCompare(b.key));
  return { schema: JOB_COST_SCHEMA, version: 1, window_hours: hours, by, known: true, total: { key: 'all', ...rollup(runs, measured) }, rows };
}

const pctText = (c: number | null): string => c === null ? 'unknown' : `${Math.round(c * 100)}%`;
const numText = (n: number | null): string => n === null ? 'unknown' : String(Math.round(n));

export function jobsCostLines(report: JobsCost): string[] {
  if (!report.known) return ['Cost: unknown (job metrics file unreadable)'];
  const head = [report.by, 'jobs', 'merged', 'coverage', 'tokens', 'tokens/merged PR'];
  const body = [...report.rows, report.total].map(r => [r.key, String(r.jobs), String(r.merged), pctText(r.coverage), numText(r.tokens_total), numText(r.tokens_per_merged_pr)]);
  const width = head.map((h, i) => Math.max(h.length, ...body.map(r => r[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => i === 0 ? c.padEnd(width[i]!) : c.padStart(width[i]!)).join('  ');
  return [`Finished jobs in the last ${report.window_hours} hours`, fmt(head), ...body.map(fmt)];
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
