/**
 * Why fleet runs end with no change (RQ-EMPTYWHYN19NQ8): one reason per empty run, plus a rollup.
 *
 * Reuses the existing readers: `ledgerRows`/`finishesIn` pick each job's newest finish, `readText`
 * does the bounded no-follow file reads, `jobFamily` names the family. The classifier is pure and
 * sees only one job's metric rows, the tail of its log, its publish result and its launch note.
 * Evidence is one short line with secret-shaped text and home paths scrubbed. Tokens that were not
 * recorded stay null ("unknown"), never zero.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_CAUSE_TAIL_LINES, ledgerRows, readText } from './empty-cause.js';
import { finishesIn } from './empties.js';
import { TIMEOUT_EXITS } from './lane-empty-causes.js';
import { jobFamily } from './slot-yield.js';
import { redactGenericHomePaths, scrubSecrets } from '../util/scrub-secrets.js';

/** Checked in this order; the first match wins. */
export const EMPTY_RUN_REASONS = ['plan_limit', 'held', 'precheck_skip', 'publish_abort', 'already_done', 'blocked', 'no_output', 'unknown'] as const;
export type EmptyRunReason = (typeof EMPTY_RUN_REASONS)[number];

export interface EmptyRunInput {
  job: string;
  /** This job's metric rows (`metrics/jobs.jsonl`), oldest first. */
  events: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** The worker log (`<runs>/<job>.log`); null when missing. Only its final lines are read. */
  log: string | null;
  /** The publish result (`<runs>/<job>.publish`); null when missing. */
  publish: string | null;
  /** The launch note (`<runs>/<job>.launch`); null when missing. */
  launchNote: string | null;
}

export interface EmptyRun {
  job: string; lane: string; tier: string; family: string;
  reason: EmptyRunReason;
  /** One short line that shows the reason; null when there is nothing to quote. */
  evidence: string | null;
  /** Recorded tokens for the newest finish; null when not recorded. */
  tokens_total: number | null;
}

const LIMIT = /\b(?:usage|quota|rate|plan|session|weekly|daily|monthly|spend(?:ing)?|credit)[ -]?limits?\b|\bhit (?:your|the) limit\b|\blimit (?:reached|exceeded|resets?)\b|\bquota (?:exceeded|exhausted)\b|insufficient_quota|credit balance|out of (?:credits|extra usage)|\b(?:HTTP|status(?: code)?) 429\b|too many requests/i;
const ALREADY = /\balready (?:on|in|landed on|merged (?:in|to|into)|merged|landed|implemented|done|fixed|covered|shipped|exists?)\b|\bnothing (?:left )?to (?:do|fix|change|commit)\b|\bno changes? (?:is |are |was |were )?needed\b|\bno[- ]op\b|EMPTY_REASON: (?:duplicate-landed|no-change-needed)\b/i;
const BLOCKED = /command not found|\bspawn \S+ ENOENT\b|no such file or directory|\bis not installed\b|executable file not found|\b(?:EPERM|EACCES)\b|permission denied|operation not permitted|\bsandbox[^\n]{0,40}\b(?:deny|denied|blocked)\b|not logged in|could not resolve host|\bENOTFOUND\b|\bECONNREFUSED\b|network (?:is )?(?:unreachable|unavailable|blocked)|EMPTY_REASON: blocked\b/i;
const INTERRUPTED = new Set([...TIMEOUT_EXITS, 130]);
const LABEL = /^[\w][\w.-]{0,63}$/;
const EVIDENCE_MAX = 160;

const label = (value: unknown): string | null => typeof value === 'string' && LABEL.test(value) ? value : null;
const whole = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
type Row = Readonly<Record<string, unknown>>;
/** The newest non-null pick across rows (oldest first). */
function lastOf<T>(rows: readonly Row[], pick: (row: Row) => T | null): T | null {
  for (let i = rows.length - 1; i >= 0; i--) { const value = pick(rows[i]!); if (value !== null) return value; }
  return null;
}

/** Pure: one printable line, short, with secrets and home paths scrubbed. */
export function quoteEvidence(line: string): string | null {
  const flat = line.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const clean = scrubSecrets(redactGenericHomePaths(flat));
  return clean.length > EVIDENCE_MAX ? `${clean.slice(0, EVIDENCE_MAX - 3)}...` : clean;
}

const linesOf = (text: string | null, last = EMPTY_CAUSE_TAIL_LINES): string[] =>
  text === null ? [] : text.split(/\r?\n/).slice(-last).filter(line => line.trim() !== '');
/** The newest line that matches, quoted. */
const matching = (lines: readonly string[], pattern: RegExp): string | null | undefined => {
  for (let i = lines.length - 1; i >= 0; i--) if (pattern.test(lines[i]!)) return quoteEvidence(lines[i]!);
  return undefined;
};

/** Pure: why one finished-empty job produced no change. */
export function classifyEmptyRun(input: EmptyRunInput): EmptyRun {
  const { events } = input;
  const finishes = events.filter(row => row.event === 'finish' || row.event === 'outcome');
  const head = {
    job: input.job,
    lane: lastOf(events, row => label(row.lane)) ?? 'unknown',
    tier: lastOf(events, row => label(row.tier)) ?? 'unknown',
    family: jobFamily(input.job),
  };
  const tokens_total = lastOf(finishes, row => whole(row.tokens_total));
  const done = (reason: EmptyRunReason, evidence: string | null): EmptyRun => ({ ...head, reason, evidence, tokens_total });
  // The log head echoes the prompt, which can name any of these phrases: only its final lines count.
  const tail = linesOf(input.log);
  const publish = linesOf(input.publish, 200);

  const poolError = lastOf(events, row => typeof row.pool_error === 'string' && row.pool_error ? row.pool_error : null);
  if (poolError !== null) return done('plan_limit', `pool_error ${label(poolError) ?? 'recorded'}`);
  const limit = matching(tail, LIMIT) ?? matching(publish, LIMIT);
  if (limit !== undefined) return done('plan_limit', limit);

  const note = input.launchNote?.trimStart() ?? '';
  if (/^HELD\b/.test(note)) return done('held', quoteEvidence(note.split(/\r?\n/, 1)[0]!));

  const skip = [...events].reverse().find(row => (row.event === 'precheck_skip' && row.applied !== false) || row.event === 'skipped_empty');
  if (skip) return done('precheck_skip', `precheck_skip code ${label(skip.code) ?? label(skip.reason) ?? 'unknown'}`);

  // publish.sh ends with one RESULT line; ABORT (or DENIED) names the gate or step that refused.
  const result = [...publish].reverse().find(line => line.startsWith('RESULT '));
  if (result && /^RESULT (?:ABORT|DENIED)\b/.test(result)) return done('publish_abort', quoteEvidence(result));

  const already = matching(tail, ALREADY);
  if (already !== undefined) return done('already_done', already);
  const blocked = matching(tail, BLOCKED);
  if (blocked !== undefined) return done('blocked', blocked);

  if (!tail.length) return done('no_output', input.log === null ? 'no log' : 'log is empty');
  const exit = lastOf(finishes, row => whole(row.exit_code));
  if (exit !== null && INTERRUPTED.has(exit)) return done('no_output', `log ends mid-run (exit ${exit})`);
  return done('unknown', quoteEvidence(tail.at(-1)!));
}

export interface EmptiesWhyGroup { name: string; jobs: number; tokens_total: number | null; tokens_unknown_jobs: number }
export interface EmptiesWhyReport {
  schema: 'fleet.empties.why.v1';
  hours: number;
  /** False when the metrics file is unreadable; every count is then null. */
  known: boolean;
  empties: number | null;
  /** Sum of recorded tokens; null when no empty run recorded any. */
  tokens_total: number | null;
  tokens_unknown_jobs: number | null;
  /** Every reason in check order, including zero counts. */
  by_reason: Array<EmptiesWhyGroup & { name: EmptyRunReason }>;
  /** Most jobs first, then name. */
  by_lane: EmptiesWhyGroup[];
  by_family: EmptiesWhyGroup[];
  /** The 10 empty runs with the most recorded tokens; runs with unknown tokens are not ranked. */
  costliest: EmptyRun[];
  /** Every empty run in the window, by job id. */
  runs: EmptyRun[];
}

function group(runs: readonly EmptyRun[], key: (run: EmptyRun) => string, order?: readonly string[]): EmptiesWhyGroup[] {
  const groups = new Map<string, EmptyRun[]>((order ?? []).map(name => [name, []]));
  for (const run of runs) {
    const members = groups.get(key(run));
    if (members) members.push(run); else groups.set(key(run), [run]);
  }
  const rows = [...groups].map(([name, members]) => {
    const known = members.filter(run => run.tokens_total !== null);
    return {
      name, jobs: members.length,
      tokens_total: known.length ? known.reduce((sum, run) => sum + run.tokens_total!, 0) : null,
      tokens_unknown_jobs: members.length - known.length,
    };
  });
  return order ? rows : rows.sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name));
}

/** Pure: the rollup over runs already classified. `runs` null means the metrics file was unreadable. */
export function rollupEmptyRuns(runs: readonly EmptyRun[] | null, hours: number): EmptiesWhyReport {
  if (runs === null) {
    return { schema: 'fleet.empties.why.v1', hours, known: false, empties: null, tokens_total: null, tokens_unknown_jobs: null,
      by_reason: group([], run => run.reason, EMPTY_RUN_REASONS) as EmptiesWhyReport['by_reason'], by_lane: [], by_family: [], costliest: [], runs: [] };
  }
  const sorted = [...runs].sort((a, b) => a.job.localeCompare(b.job));
  const [all] = group(sorted, () => 'all', ['all']);
  return {
    schema: 'fleet.empties.why.v1', hours, known: true, empties: sorted.length,
    tokens_total: all!.tokens_total, tokens_unknown_jobs: all!.tokens_unknown_jobs,
    by_reason: group(sorted, run => run.reason, EMPTY_RUN_REASONS) as EmptiesWhyReport['by_reason'],
    by_lane: group(sorted, run => run.lane),
    by_family: group(sorted, run => run.family),
    costliest: sorted.filter(run => run.tokens_total !== null)
      .sort((a, b) => b.tokens_total! - a.tokens_total! || a.job.localeCompare(b.job)).slice(0, 10),
    runs: sorted,
  };
}

const LEDGER_MAX_BYTES = 32 * 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const NOTE_MAX_BYTES = 16 * 1024;

export interface ReadEmptiesWhyOptions {
  hours: number;
  now?: number;
  /** Fleet runs folder; default `ASHLR_RUNS_DIR` or `~/.ashlr-runs`. Logs, publish results and launch notes live here. */
  runsDir?: string;
  /** Metrics file; default `<runsDir>/metrics/jobs.jsonl`. */
  jobsPath?: string;
  /** Injected ledger text (tests, shared reads); null means unreadable. */
  ledger?: () => Promise<string | null>;
}

/** Read-only: classify every job whose newest finish in the window was empty. Never throws on missing files. */
export async function readEmptiesWhy(opts: ReadEmptiesWhyOptions): Promise<EmptiesWhyReport> {
  const now = opts.now ?? Date.now();
  const root = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  const text = opts.ledger ? await opts.ledger().catch(() => null) : await readText(opts.jobsPath ?? join(root, 'metrics', 'jobs.jsonl'), LEDGER_MAX_BYTES);
  if (text === null) return rollupEmptyRuns(null, opts.hours);
  const { rows } = ledgerRows(text, now, opts.hours);
  const byJob = new Map<string, Record<string, unknown>[]>();
  for (const { id, row } of [...rows].sort((a, b) => a.at - b.at)) {
    const events = byJob.get(id);
    if (events) events.push(row); else byJob.set(id, [row]);
  }
  const empty = finishesIn(rows).filter(finish => finish.empty);
  const runs: EmptyRun[] = [];
  for (let i = 0; i < empty.length; i += 16) {
    runs.push(...await Promise.all(empty.slice(i, i + 16).map(async ({ id }) => {
      // Ids come from ledgerRows, which refuses anything that could leave the runs folder.
      const [log, publish, launchNote] = await Promise.all([
        readText(join(root, `${id}.log`), LOG_TAIL_BYTES),
        readText(join(root, `${id}.publish`), NOTE_MAX_BYTES),
        readText(join(root, `${id}.launch`), NOTE_MAX_BYTES),
      ]);
      return classifyEmptyRun({ job: id, events: byJob.get(id) ?? [], log, publish, launchNote });
    })));
  }
  return rollupEmptyRuns(runs, opts.hours);
}

const tokenText = (tokens: number | null, unknownJobs: number | null): string => tokens === null ? 'tokens unknown'
  : `${tokens.toLocaleString('en-US')} tokens${unknownJobs ? ` (${unknownJobs} unknown)` : ''}`;

/** Pure: the plain-words view, at most about 20 lines. */
export function emptiesWhyText(report: EmptiesWhyReport): string[] {
  if (!report.known) return [`Why runs ended empty (last ${report.hours} h): unknown, the job metrics file could not be read.`];
  if (!report.empties) return [`Why runs ended empty (last ${report.hours} h): no empty runs.`];
  const lines = [`Why runs ended empty (last ${report.hours} h): ${report.empties} runs, ${tokenText(report.tokens_total, report.tokens_unknown_jobs)}.`];
  for (const row of report.by_reason.filter(r => r.jobs).sort((a, b) => b.jobs - a.jobs)) lines.push(`  ${row.name.replace('_', ' ')}: ${row.jobs}, ${tokenText(row.tokens_total, row.tokens_unknown_jobs)}`);
  lines.push(`By lane: ${report.by_lane.slice(0, 5).map(row => `${row.name} ${row.jobs}`).join(', ')}`);
  lines.push(`By family: ${report.by_family.slice(0, 5).map(row => `${row.name} ${row.jobs}`).join(', ')}`);
  if (report.costliest.length) lines.push('Costliest empty runs:');
  for (const run of report.costliest.slice(0, 5)) {
    lines.push(`  ${run.job} (${run.lane}): ${tokenText(run.tokens_total, 0)}, ${run.reason.replace('_', ' ')}${run.evidence ? `: "${run.evidence}"` : ''}`);
  }
  return lines;
}
