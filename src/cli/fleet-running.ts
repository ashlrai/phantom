import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: phm fleet running [--json]';
const MAX_LINES = 3000;
const WINDOW_MS = 6 * 3_600_000;

export interface RunningJob {
  job: string; lane: string; model: string; repo: string; tier: string; minutes: number;
}
export interface RunningReport {
  schema: 'fleet.running.v1';
  by_lane: Record<string, number>;
  total: number;
  jobs: RunningJob[];
}
/** Returns the raw text of the jobs ledger. Injected so tests never touch the real home. */
export type JobsReader = () => Promise<string>;

export const readJobsLedger: JobsReader = () => readFile(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'utf8');

/** Parses ISO times, including offsets written as -0500 or +0530 and a space instead of T. */
export function parseTs(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const text = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(text);
}

const text = (v: unknown): string => typeof v === 'string' && v ? v : '-';

/** Jobs with a launch in the last 6 hours and no finish at or after it, from the last 3000 ledger lines. */
export function runningJobs(ledger: string, now: number): RunningReport {
  const lines = ledger.split(/\r?\n/).filter(l => l.trim()).slice(-MAX_LINES);
  const seen = new Map<string, { launch: number; finished: boolean; info: Record<string, string> }>();
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      row = v as Record<string, unknown>;
    } catch { continue; }
    const id = row.job ?? row.job_id ?? row.jobId;
    const at = parseTs(row.ts ?? row.timestamp ?? row.at);
    const event = row.event ?? row.type;
    if (typeof id !== 'string' || !id || !Number.isFinite(at)) continue;
    const entry = seen.get(id) ?? { launch: NaN, finished: false, info: {} };
    seen.set(id, entry);
    for (const key of ['lane', 'model', 'repo', 'tier']) if (typeof row[key] === 'string' && row[key]) entry.info[key] = row[key] as string;
    if (event === 'launch' && !(at < entry.launch)) {
      if (at > entry.launch || Number.isNaN(entry.launch)) entry.finished = false;
      entry.launch = at;
    } else if (event === 'finish' && !(at < entry.launch)) entry.finished = true;
    else if (event === 'finish' && Number.isNaN(entry.launch)) entry.finished = true;
  }
  const jobs: RunningJob[] = [];
  for (const [job, e] of seen) {
    if (e.finished || !Number.isFinite(e.launch) || e.launch > now || now - e.launch > WINDOW_MS) continue;
    jobs.push({ job, lane: text(e.info.lane), model: text(e.info.model), repo: text(e.info.repo), tier: text(e.info.tier),
      minutes: Math.floor((now - e.launch) / 60_000) });
  }
  // Oldest first inside a lane.
  jobs.sort((a, b) => a.lane.localeCompare(b.lane) || b.minutes - a.minutes || a.job.localeCompare(b.job));
  const by_lane: Record<string, number> = {};
  for (const j of jobs) by_lane[j.lane] = (by_lane[j.lane] ?? 0) + 1;
  return { schema: 'fleet.running.v1', by_lane, total: jobs.length, jobs };
}

export function formatRunning(report: RunningReport): string {
  const counts = Object.entries(report.by_lane).map(([lane, n]) => `${lane}=${n}`).join(' ');
  const head = `Running now: ${report.total}${counts ? ` (${counts})` : ''}`;
  return [head, ...report.jobs.map(j => `${j.job}  ${j.lane}  ${j.model}  ${j.repo}  ${j.tier}  ${j.minutes}m`)].join('\n');
}

export async function cmdFleetRunning(args: string[], read: JobsReader = readJobsLedger, now: () => number = Date.now): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.some(a => a !== '--json') || args.length > 1) { console.error(usage); return 2; }
  let ledger: string;
  try { ledger = await read(); } catch { console.error('error: unable to read jobs ledger'); return 1; }
  const report = runningJobs(ledger, now());
  console.log(args[0] === '--json' ? JSON.stringify(report) : formatRunning(report));
  return 0;
}
