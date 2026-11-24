/**
 * `phm fleet eval-report` — weekly "fleet IQ" post-merge durability report.
 *
 * Read-only analytics (RQ-SWE3-EVALFLEET-1): folds the metrics jobs ledger,
 * an optional gh-shaped merged-PR export and the signed post-merge
 * observation ledger into per-lane/tier revert, follow-up, CI-correlation
 * and time-to-merge rates. Never merges, routes, requeues or releases
 * credit; unknown evidence is reported, never guessed.
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildFleetEvalReport,
  formatFleetEvalReport,
  DEFAULT_EVAL_DAYS,
  MAX_EVAL_DAYS,
  type EvalReportJobsRead,
  type FleetEvalReport,
} from '../core/fleet/eval-report.js';
import { buildProofOutcomeReport, formatProofOutcomeReport } from '../core/fleet/proof-outcome-join.js';
import { readPostMergeObservations, type PostMergeObservationReadResult } from '../core/fleet/post-merge-observations.js';
import { readLedgerTail } from '../core/router/outcomes.js';

const usage = `Usage: phm fleet eval-report [--jobs <file>] [--prs <file>]... [--days <n>] [--until <iso>] [--no-observations] [--json]

Read-only weekly "fleet IQ" report: scores every merged PR for post-merge
durability (reverted / regressed / followed-up / stable / pending /
unobserved) and rolls revert, follow-up, CI-correlation and time-to-merge
rates up by lane, tier, lane+tier and repo.

  --jobs <file>        Metrics jobs ledger. Default: ~/.ashlr-runs/metrics/jobs.jsonl
  --prs <file>         gh-shaped merged-PR export; repeatable (JSON array or
                       JSONL). Adds mergeCommit joins, statusCheckRollup CI
                       evidence, and revert/overlapping-fix detection.
                       Produce with: gh pr list --state merged --json url,number,title,mergedAt,mergeCommit,files,statusCheckRollup,commits,body
  --days <n>           Look-back window, 1-${MAX_EVAL_DAYS} days (default ${DEFAULT_EVAL_DAYS}).
  --until <iso>        Window end (default: now).
  --no-observations    Skip the signed post-merge observation ledger.
  --json               One JSON object on stdout.

Evidence honesty: a merge is "stable" only when the 72h window elapsed and
an evidence channel covered its repo; uncovered merges count as
"unobserved". Rankings sort on the Wilson lower bound. Nothing here merges,
routes or releases credit.`;

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PRS_FILES = 8;

async function readText(path: string, max = MAX_FILE_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Newest bounded tail of the append-only jobs ledger; null when missing/unreadable. */
const readJobsTail: NonNullable<FleetEvalReportDeps['read']> = async (path) => {
  const tail = await readLedgerTail(path);
  return tail.state === 'read' ? { text: tail.text, truncated: tail.truncated } : null;
};

export interface FleetEvalReportDeps {
  /** File reader for --jobs/--prs paths. A bare string is a complete read;
   * { text, truncated } marks a bounded tail. Defaults: the jobs ledger reads
   * its newest tail (readLedgerTail), --prs exports read whole-file. */
  read?: (path: string) => Promise<string | EvalReportJobsRead | null>;
  observations?: () => PostMergeObservationReadResult;
  now?: () => number;
}

interface Parsed {
  json: boolean;
  jobs?: string;
  prs: string[];
  days: number;
  until?: number;
  observations: boolean;
  resultsDir?: string;
}

function parseArgs(args: string[], allowResultsDir = false): Parsed | null {
  const parsed: Parsed = { json: false, prs: [], days: DEFAULT_EVAL_DAYS, observations: true };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const take = (flag: string): string | null => {
      if (arg !== flag || next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    if (arg === '--json' && !parsed.json) parsed.json = true;
    else if (arg === '--no-observations' && parsed.observations) parsed.observations = false;
    else if (allowResultsDir && arg === '--results-dir' && parsed.resultsDir === undefined) {
      const value = take('--results-dir');
      if (value === null) return null;
      parsed.resultsDir = value;
    } else if (arg === '--jobs' && parsed.jobs === undefined) {
      const value = take('--jobs');
      if (value === null) return null;
      parsed.jobs = value;
    } else if (arg === '--prs') {
      if (parsed.prs.length >= MAX_PRS_FILES) return null;
      const value = take('--prs');
      if (value === null) return null;
      parsed.prs.push(value);
    } else if (arg === '--days' && !seen.has('--days')) {
      const value = take('--days');
      const days = Number(value);
      if (value === null || !Number.isInteger(days) || days < 1 || days > MAX_EVAL_DAYS) return null;
      parsed.days = days;
    } else if (arg === '--until' && parsed.until === undefined) {
      const value = take('--until');
      const at = value === null ? NaN : Date.parse(value);
      if (!Number.isFinite(at)) return null;
      parsed.until = at;
    } else return null;
    seen.add(arg);
  }
  return parsed;
}

export async function cmdFleetEvalReport(args: string[], deps: FleetEvalReportDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  return runEvalReport(parsed, deps, (report) =>
    parsed.json ? `${JSON.stringify(report)}\n` : `${formatFleetEvalReport(report)}\n`);
}

/** `phm fleet proof outcomes`: eval-report inputs plus --results-dir, joined to proof artifacts. */
export async function cmdFleetProofOutcomes(args: string[], deps: FleetEvalReportDeps = {}): Promise<number> {
  const parsed = parseArgs(args, true);
  if (!parsed) {
    process.stderr.write(`${PROOF_OUTCOMES_USAGE}\n`);
    return 2;
  }
  const resultsDir = parsed.resultsDir ?? join(homedir(), '.ashlr-runs');
  return runEvalReport(parsed, deps, (report) => {
    const joined = buildProofOutcomeReport(report, resultsDir);
    return parsed.json ? `${JSON.stringify(joined)}\n` : `${formatProofOutcomeReport(joined)}\n`;
  });
}

export const PROOF_OUTCOMES_USAGE = `Usage: phm fleet proof outcomes [--results-dir <dir>] [--jobs <file>] [--prs <file>]... [--days <n>] [--until <iso>] [--no-observations] [--json]

Read-only join of publisher proof artifacts to post-merge outcomes: did a
verified proof predict a durable merge? Each merged PR is attributed to its
job, the job's <id>.publish proof marker is verified (never executing recorded
commands), and durability is rolled up by proof state with Wilson intervals.
Missing or unreadable proof is reported as such, never guessed.

  --results-dir <dir>  Directory holding <job>.publish and proof files. Default: ~/.ashlr-runs
  Other flags match \`phm fleet eval-report\`. Emits fleet.proof-outcomes.v1.`;

async function runEvalReport(
  parsed: Parsed,
  deps: FleetEvalReportDeps,
  render: (report: FleetEvalReport) => string,
): Promise<number> {
  const jobsPath = parsed.jobs ?? join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  const jobsText = await (deps.read ?? readJobsTail)(jobsPath);
  const prsTexts: string[] = [];
  let prsUnreadable = 0;
  for (const path of parsed.prs) {
    const raw = await (deps.read ?? readText)(path);
    const text = raw === null ? null : typeof raw === 'string' ? raw : raw.text;
    if (text === null) prsUnreadable++;
    else prsTexts.push(text);
  }
  const observations = parsed.observations
    ? (deps.observations ?? readPostMergeObservations)()
    : null;
  if (jobsText === null && prsTexts.length === 0 && !observations?.observations.length) {
    process.stderr.write('error: no eval-report inputs available (jobs ledger unreadable, no --prs export, observation ledger empty)\n');
    return 1;
  }
  const report: FleetEvalReport = buildFleetEvalReport({
    jobsText,
    prsTexts,
    observations: observations === null
      ? null
      : {
          sourceState: observations.sourceState,
          rows: observations.observations.map((o) => ({
            outcome: o.outcome,
            mergeCommit: o.mergeCommit,
            confidence: o.confidence,
          })),
        },
    nowMs: (deps.now ?? Date.now)(),
    windowDays: parsed.days,
    untilMs: parsed.until,
  });
  if (prsUnreadable > 0) {
    process.stderr.write(`warning: ${prsUnreadable} --prs file(s) unreadable\n`);
  }
  process.stdout.write(render(report));
  return 0;
}
