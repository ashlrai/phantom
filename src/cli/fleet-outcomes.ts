/** Read-only outcome learning: stats, improvement jobs, and the next assignment. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  formatOutcomeLearning,
  learnOutcomes,
  offersFromLearning,
  outcomeLearningView,
  routeLearnedJob,
  type LearnedPriority,
  type LearnedRoute,
  type OutcomeLearningView,
  type ResourceOffer,
} from '../core/routing/outcome-learning.js';

const usage = `Usage: phm fleet outcomes [--events <file>] [--json]
       phm fleet outcomes route --repo <repo> --type <jobType> [--priority critical|normal] [--job <id>] [--offers <file>] [--events <file>] [--json]

--events <file>  Dispatch event log. Default: ~/.ashlr-runs/queue/dispatch-events.log
--offers <file>  JSON array of resources that can take the job. Without it, every resource in the log is treated as free.
--json           One JSON object on stdout.

Prints merge rate, time to merge, usage, and breakage for each resource, model, job type, and repo, plus improvement jobs for recurring failures. route adds the assignment and a plain-language reason. The log is the memory; there is no routing setting to tune.`;

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

export async function cmdFleetOutcomes(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const text = await readEvents(parsed.events);
  if (text === null) {
    const empty = payload({ schema: 'routing.outcome-learning.v1', finished: 0, malformed: 0, cells: [], improvementJobs: [] }, null);
    if (parsed.json) process.stdout.write(`${JSON.stringify(empty)}\n`);
    else process.stderr.write('error: event log unavailable\n');
    return 1;
  }
  const learning = learnOutcomes(text);
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
