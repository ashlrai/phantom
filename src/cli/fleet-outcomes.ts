/** Read-only outcomes: what each finished job produced (--lane), plus outcome learning stats, improvement jobs, and the next assignment. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  censorFromConfig,
  formatOutcomeLearning,
  learnFleetOutcomes,
  offersFromLearning,
  outcomeLearningView,
  routeLearnedJob,
  type LearnedPriority,
  type LearnedRoute,
  type OutcomeLearningView,
  type ResourceOffer,
} from '../core/routing/outcome-learning.js';
import { readStandingRevertKeys } from '../core/improve/revert-ledger.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../core/router/outcomes.js';

const usage = `Usage: phm fleet outcomes --lane <lane|all> [--hours 24] [--json]
       phm fleet outcomes [--events <file>] [--ledger <file>] [--json]
       phm fleet outcomes route --repo <repo> --type <jobType> [--priority critical|normal] [--job <id>] [--offers <file>] [--events <file>] [--ledger <file>] [--json]

--events <file>  Dispatch event log. Default: ~/.ashlr-runs/queue/dispatch-events.log
--ledger <file>  Jobs ledger (launch/finish/reconciler rows). Default: <runs dir>/metrics/jobs.jsonl
--offers <file>  JSON array of resources that can take the job. Without it, every resource in the log is treated as free.
--json           One JSON object on stdout.

--lane <lane>   What each finished job in the last --hours (default 24) produced: merged, pr open, pr closed, empty or failed. The exit code never decides alone: a job that exited 1 but whose PR merged is merged. Shows the top 3 plain-words reasons for empty and failed, from the end of each job log. JSON schema: fleet.job-outcomes.v1.
--runs-dir <dir> and --jobs <file> point that report at another runs folder or jobs ledger.

Without --lane, prints merge rate, time to merge, usage, and breakage for each resource, model, job type, and repo, plus improvement jobs for recurring failures. route adds the assignment and a plain-language reason. The logs are the memory; there is no routing setting to tune.`;

const MAX_BYTES = 8 * 1024 * 1024;

async function readText(path: string, max = MAX_BYTES): Promise<string | null> {
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

function defaultEventLog(): string {
  return join(homedir(), '.ashlr-runs', 'queue', 'dispatch-events.log');
}

function fallbackEventLog(): string {
  return join(homedir(), '.ashlr-runs', 'dispatch-events.log');
}

async function readEvents(path: string | undefined): Promise<string | null> {
  if (path) return readText(path);
  return await readText(defaultEventLog()) ?? await readText(fallbackEventLog());
}

function defaultJobsLedger(): string {
  const runsDir = process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  return join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
}

/** Bounded tail of the jobs ledger; null when the file is missing or unreadable. */
async function readJobsLedger(path: string | undefined): Promise<string | null> {
  const tail = await readLedgerTail(path ?? defaultJobsLedger());
  return tail.state === 'read' ? tail.text : null;
}

function isOffer(value: unknown): value is ResourceOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row['resource'] === 'string' && typeof row['model'] === 'string'
    && typeof row['slots'] === 'number'
    && (row['usageLeftPercent'] === null || typeof row['usageLeftPercent'] === 'number')
    && (row['resetAt'] === null || typeof row['resetAt'] === 'string')
    && (row['exhausted'] === undefined || typeof row['exhausted'] === 'boolean');
}

async function readOffers(path: string): Promise<ResourceOffer[] | null> {
  const text = await readText(path, 1024 * 1024);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || !value.every(isOffer)) return null;
    return value;
  } catch {
    return null;
  }
}

interface Parsed {
  mode: 'report' | 'route';
  json: boolean;
  events?: string;
  ledger?: string;
  offers?: string;
  repo?: string;
  jobType?: string;
  job: string;
  priority: LearnedPriority;
}

function parseArgs(args: string[]): Parsed | null {
  const parsed: Parsed = { mode: 'report', json: false, job: 'route', priority: 'normal' };
  let jobSet = false;
  let prioritySet = false;
  const rest = args[0] === 'route' ? (parsed.mode = 'route', args.slice(1)) : args;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];
    const take = (flag: string): string | null => {
      if (arg !== flag || next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    if (arg === '--json' && !parsed.json) parsed.json = true;
    else if (arg === '--events' && parsed.events === undefined) {
      const value = take('--events');
      if (value === null) return null;
      parsed.events = value;
    } else if (arg === '--ledger' && parsed.ledger === undefined) {
      const value = take('--ledger');
      if (value === null) return null;
      parsed.ledger = value;
    } else if (arg === '--offers' && parsed.offers === undefined) {
      const value = take('--offers');
      if (value === null) return null;
      parsed.offers = value;
    } else if (arg === '--repo' && parsed.repo === undefined) {
      const value = take('--repo');
      if (value === null) return null;
      parsed.repo = value;
    } else if (arg === '--type' && parsed.jobType === undefined) {
      const value = take('--type');
      if (value === null) return null;
      parsed.jobType = value;
    } else if (arg === '--job' && !jobSet) {
      const value = take('--job');
      if (value === null) return null;
      parsed.job = value;
      jobSet = true;
    } else if (arg === '--priority' && !prioritySet) {
      const value = take('--priority');
      if (value !== 'critical' && value !== 'normal') return null;
      parsed.priority = value;
      prioritySet = true;
    } else return null;
  }
  if (parsed.mode === 'route' && (parsed.repo === undefined || parsed.jobType === undefined)) return null;
  return parsed;
}

function payload(view: OutcomeLearningView, route: LearnedRoute | null): OutcomeLearningView & { route: LearnedRoute | null } {
  return { ...view, route };
}

const JOB_FLAGS = new Set(['--lane', '--hours', '--runs-dir', '--jobs']);

/** `--lane <lane|all> [--hours N] [--runs-dir d] [--jobs f] [--json]`: what each finished job produced. */
async function cmdJobOutcomes(args: string[]): Promise<number> {
  const seen = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (seen.has(arg)) { process.stderr.write(`${usage}\n`); return 2; }
    if (arg === '--json') { seen.set(arg, true); continue; }
    const value = args[i + 1];
    if (!JOB_FLAGS.has(arg) || value === undefined || value.startsWith('--')) { process.stderr.write(`${usage}\n`); return 2; }
    seen.set(arg, value);
    i += 1;
  }
  const hoursText = seen.get('--hours');
  const hours = hoursText === undefined ? 24 : /^\d+(?:\.\d+)?$/.test(String(hoursText)) ? Number(hoursText) : NaN;
  const lane = seen.get('--lane');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 2160 || (lane !== undefined && lane === true)) { process.stderr.write(`${usage}\n`); return 2; }
  const { readJobOutcomes, jobOutcomesText } = await import('../core/fleet/job-outcomes.js');
  const report = await readJobOutcomes({
    hours,
    ...(typeof lane === 'string' && lane !== 'all' ? { lane } : {}),
    ...(typeof seen.get('--runs-dir') === 'string' ? { runsDir: seen.get('--runs-dir') as string } : {}),
    ...(typeof seen.get('--jobs') === 'string' ? { jobsPath: seen.get('--jobs') as string } : {}),
  });
  process.stdout.write(seen.has('--json') ? `${JSON.stringify(report)}\n` : `${jobOutcomesText(report).join('\n')}\n`);
  return report.known ? 0 : 1;
}

export async function cmdFleetOutcomes(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (args.some(arg => JOB_FLAGS.has(arg))) return cmdJobOutcomes(args);
  const parsed = parseArgs(args);
  if (!parsed) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const [text, ledger] = await Promise.all([readEvents(parsed.events), readJobsLedger(parsed.ledger)]);
  if (text === null && ledger === null) {
    const empty = payload({ schema: 'routing.outcome-learning.v1', finished: 0, malformed: 0, cells: [], improvementJobs: [] }, null);
    if (parsed.json) process.stdout.write(`${JSON.stringify(empty)}\n`);
    else process.stderr.write('error: event log unavailable\n');
    return 1;
  }
  const { loadConfigReadOnly } = await import('../core/config.js');
  const learning = learnFleetOutcomes(text, ledger, censorFromConfig(loadConfigReadOnly().router, Date.now()), readStandingRevertKeys());
  const view = outcomeLearningView(learning);
  let route: LearnedRoute | null = null;
  if (parsed.mode === 'route') {
    const offers = parsed.offers ? await readOffers(parsed.offers) : offersFromLearning(learning);
    if (offers === null) {
      process.stderr.write(`${usage}\n`);
      return 2;
    }
    route = routeLearnedJob(learning, {
      id: parsed.job,
      repo: parsed.repo!,
      jobType: parsed.jobType!,
      priority: parsed.priority,
    }, offers, { nowMs: Date.now() });
  }
  process.stdout.write(parsed.json ? `${JSON.stringify(payload(view, route))}\n` : `${formatOutcomeLearning(view, route)}\n`);
  return 0;
}
