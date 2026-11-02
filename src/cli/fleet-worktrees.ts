/**
 * `ashlr fleet worktrees` — read-only size report for job worktrees.
 *
 * Lists every direct subfolder of ~/Projects/ashlrai/wt with its size in GB
 * and its age in hours, biggest first, then a total line. A folder is marked
 * merged when its name is a job id with an `outcome` row in the state MERGED in
 * ~/.ashlr-runs/metrics/jobs.jsonl.
 *
 * Two injected readers, no writes: `du` (size) and `readJobs` (outcomes). A
 * failed du prints `unknown` for sizes and the total; an unread jobs file
 * prints `unknown` for merged. Never a guessed zero.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readSource, type Source } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { defaultDu, parseDuSubdirs } from './fleet-disk.js';

export const FLEET_WORKTREES_MAX_JOBS_BYTES = 8 * 1024 * 1024;
const USAGE = 'usage: ashlr fleet worktrees [--wt-dir <abs>] [--json]';

type Output = { log: (message: string) => void; error: (message: string) => void };
type JobsSource = { state: Source; text: string };
export interface FleetWorktreesDeps {
  now?: number;
  wtRoot?: string;
  runsRoot?: string;
  output?: Output;
  /** Injected `du -k`-style runner over the worktree root; returns raw stdout text. */
  du?: (root: string) => string | Promise<string>;
  /** Injected reader for metrics/jobs.jsonl; default reads a bounded tail. */
  readJobs?: (path: string) => JobsSource | Promise<JobsSource>;
  /** Injected modified-time reader (ms since epoch); null when unreadable. */
  mtimeMs?: (path: string) => number | null;
}

export interface FleetWorktreeEntry {
  name: string;
  gb: number;
  /** Hours since the folder last changed; null when its time could not be read. */
  ageHours: number | null;
  /** null = jobs file unread, so merged status is unknown. */
  merged: boolean | null;
}
export interface FleetWorktreesV1 {
  schema: 'fleet.worktrees.v1';
  generatedAt: string;
  wtDir: string;
  jobsSource: Source;
  /** Biggest first; null when `du` could not run. */
  worktrees: FleetWorktreeEntry[] | null;
  /** Sum of the sizes; null when `du` could not run. */
  totalGb: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Job ids that have an `outcome` row in the state MERGED. Pure — no I/O. */
export function parseMergedJobs(text: string): Set<string> {
  const merged = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.includes('MERGED')) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const id = r.job ?? r.job_id ?? r.id;
      if (r.event === 'outcome' && typeof id === 'string' && String(r.state).toUpperCase() === 'MERGED') merged.add(id);
    } catch { /* skip a torn or foreign row */ }
  }
  return merged;
}

const defaultMtime = (path: string): number | null => {
  try { return statSync(path).mtimeMs; } catch { return null; }
};

export async function readFleetWorktrees(deps: FleetWorktreesDeps = {}): Promise<FleetWorktreesV1> {
  const nowMs = deps.now ?? Date.now();
  const wtDir = deps.wtRoot ?? join(homedir(), 'Projects', 'ashlrai', 'wt');
  const runsDir = deps.runsRoot ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const readJobs = deps.readJobs ?? ((path: string) => readSource(path, FLEET_WORKTREES_MAX_JOBS_BYTES, true));
  let jobs: JobsSource;
  try {
    jobs = await readJobs(join(runsDir, 'metrics', 'jobs.jsonl'));
  } catch {
    jobs = { state: 'degraded', text: '' };
  }
  const merged = jobs.state === 'healthy' ? parseMergedJobs(jobs.text) : null;
  const mtime = deps.mtimeMs ?? defaultMtime;
  let worktrees: FleetWorktreeEntry[] | null = null;
  try {
    const dirs = parseDuSubdirs(await (deps.du ?? defaultDu)(wtDir), wtDir, Number.MAX_SAFE_INTEGER);
    worktrees = dirs.map(({ name, gb }) => {
      const at = mtime(join(wtDir, name));
      return {
        name,
        gb,
        ageHours: at === null ? null : Math.max(0, round1((nowMs - at) / 3_600_000)),
        merged: merged === null ? null : merged.has(name),
      };
    });
  } catch {
    worktrees = null;
  }
  return {
    schema: 'fleet.worktrees.v1',
    generatedAt: new Date(nowMs).toISOString(),
    wtDir,
    jobsSource: jobs.state,
    worktrees,
    totalGb: worktrees === null ? null : round1(worktrees.reduce((sum, w) => sum + w.gb, 0)),
  };
}

/** Collapse the operator's home to `~` for display. */
function displayDir(path: string): string {
  try {
    const home = homedir().replace(/[/\\]+$/, '');
    if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  } catch { /* no resolvable home — print the path as given */ }
  return path;
}

/** Plain words, one line per worktree, then the total. Pure — no I/O. */
export function formatFleetWorktrees(report: FleetWorktreesV1): string[] {
  const lines = [`worktrees under ${displayDir(report.wtDir)}:`];
  if (report.worktrees === null) lines.push('  unknown');
  else if (report.worktrees.length === 0) lines.push('  none');
  else for (const w of report.worktrees) {
    const size = w.gb === 0 ? '<0.1' : String(w.gb);
    const age = w.ageHours === null ? 'unknown' : `${w.ageHours} hours old`;
    const merged = w.merged === null ? 'unknown' : w.merged ? 'yes' : 'no';
    lines.push(`  ${w.name}: ${size} GB, ${age}, merged: ${merged}`);
  }
  lines.push(`total: ${report.totalGb === null ? 'unknown' : `${report.totalGb} GB`}`);
  return lines;
}

export async function cmdFleetWorktrees(args: string[], deps: FleetWorktreesDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let json = false;
  let wtRoot = deps.wtRoot;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      output.log('ashlr fleet worktrees [--wt-dir <abs>] [--json]\n' +
        'Read-only list of job worktrees under ~/Projects/ashlrai/wt: size in GB,\n' +
        'age in hours and whether the job merged, biggest first, then a total.\n' +
        'Unread sources print unknown, never zero.');
      return 0;
    }
    if (seen.has(arg)) { output.error(`error: duplicate option\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--wt-dir') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) { output.error(`error: --wt-dir needs an absolute path\n${USAGE}`); return 2; }
      wtRoot = value;
    } else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\n${USAGE}`); return 2; }
  }
  const report = await readFleetWorktrees({ ...deps, wtRoot });
  if (json) output.log(JSON.stringify(sanitizePublicJson(report)));
  else for (const line of formatFleetWorktrees(report)) output.log(line);
  return 0;
}
