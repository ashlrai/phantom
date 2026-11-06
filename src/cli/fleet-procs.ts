/** Group running processes by the job worktree named in their command line. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const USAGE =
  'Usage: ashlr fleet procs [--root <dir>] [--json]\n' +
  'Runs `ps -axo pid,ppid,pcpu,rss,command` and attributes every process to the job dir under <root> (default ~/Projects/ashlrai/wt) named in its command line. Prints one line per job — process count, total %CPU, RSS MB — for the top 10 jobs by CPU, then one "other" line covering everything else. Read-only. Exits 0 ok, 1 when ps fails, 2 bad usage.';

const TOP_JOBS = 10;
const KB_PER_MB = 1024;

export const PROCS_PS_ARGS = ['-axo', 'pid,ppid,pcpu,rss,command'];

export interface ProcRow {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  command: string;
}

export interface JobProcSummary {
  job: string;
  count: number;
  cpu: number;
  rssMb: number;
}

export interface OtherProcSummary {
  count: number;
  cpu: number;
  rssMb: number;
  /** Matched jobs beyond the top-10 cut, folded into the other line. */
  jobs: string[];
}

export interface FleetProcsView {
  v: 1;
  generatedAt: string;
  root: string;
  /** Parsed process rows, job-attributed and other alike. */
  total: number;
  jobs: JobProcSummary[];
  other: OtherProcSummary;
}

export interface FleetProcsDeps {
  /** Returns the stdout of `ps -axo pid,ppid,pcpu,rss,command`. Must never use a shell. */
  ps?: () => Promise<string>;
  now?: () => number;
}

const defaultPs = async (): Promise<string> =>
  (await execFileAsync('ps', PROCS_PS_ARGS, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** One `ps -axo pid,ppid,pcpu,rss,command` row each; header and malformed lines are skipped. */
export function parsePsRows(psOutput: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), command: m[5] });
  }
  return rows;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const jobRe = (root: string): RegExp =>
  new RegExp(`(?:^|[\\s'"(=;:])${escapeRe(root)}/([^/\\s'"\`:;&|<>()]+)`);

/** First job dir name directly under root that the command line names, else null. */
export function jobInCommand(root: string, command: string): string | null {
  return jobRe(root).exec(command)?.[1] ?? null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Buckets parsed rows per job dir; overflow jobs past the top-10 cut fold into other. */
export function summarizeJobProcs(rows: ProcRow[], root: string, now: number): FleetProcsView {
  const byJob = new Map<string, { count: number; cpu: number; rssKb: number }>();
  const rest = { count: 0, cpu: 0, rssKb: 0 };
  const re = jobRe(root);
  for (const row of rows) {
    const job = re.exec(row.command)?.[1] ?? null;
    const bucket = job === null ? rest : byJob.get(job) ?? { count: 0, cpu: 0, rssKb: 0 };
    bucket.count++;
    bucket.cpu += row.cpu;
    bucket.rssKb += row.rssKb;
    if (job !== null) byJob.set(job, bucket);
  }
  const ranked = [...byJob.entries()].sort((a, b) =>
    b[1].cpu - a[1].cpu || b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const jobs = ranked.slice(0, TOP_JOBS).map(([job, b]) =>
    ({ job, count: b.count, cpu: round1(b.cpu), rssMb: round1(b.rssKb / KB_PER_MB) }));
  const folded = ranked.slice(TOP_JOBS);
  const totals = folded.reduce((sum, [, b]) => ({
    count: sum.count + b.count, cpu: sum.cpu + b.cpu, rssKb: sum.rssKb + b.rssKb,
  }), rest);
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    root,
    total: rows.length,
    jobs,
    other: {
      count: totals.count,
      cpu: round1(totals.cpu),
      rssMb: round1(totals.rssKb / KB_PER_MB),
      jobs: folded.map(([job]) => job),
    },
  };
}

const line = (name: string, s: { count: number; cpu: number; rssMb: number }): string =>
  `${name}: ${s.count} procs, ${s.cpu}% cpu, ${s.rssMb} MB`;

export async function cmdFleetProcs(args: string[], deps: FleetProcsDeps = {}): Promise<number> {
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  let root = join(homedir(), 'Projects', 'ashlrai', 'wt');
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token !== '--root' && token !== '--json') {
      console.error(`error: ${token.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${token}\n${USAGE}`);
      return 2;
    }
    if (seen.has(token)) {
      console.error(`error: duplicate option: ${token}\n${USAGE}`);
      return 2;
    }
    seen.add(token);
    if (token === '--json') json = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        console.error(`error: --root needs a directory\n${USAGE}`);
        return 2;
      }
      root = value;
    }
  }
  root = resolve(root);

  let out: string;
  try {
    out = await (deps.ps ?? defaultPs)();
  } catch (error) {
    console.error(`error: cannot read the process list: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return 1;
  }

  const view = summarizeJobProcs(parsePsRows(out), root, (deps.now ?? Date.now)());
  if (json) {
    process.stdout.write(JSON.stringify(view, null, 2) + '\n');
  } else {
    for (const job of view.jobs) console.log(line(job.job, job));
    console.log(line('other', view.other));
  }
  return 0;
}
