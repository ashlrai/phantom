/** Read-only median and p90 minutes from CLAIMED to launch, filler versus real work. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFillerId } from './fleet-bet-wait.js';

export const FLEET_LAUNCH_WAIT_SCHEMA = 'fleet.launch-wait.v1';
const DAY = 86_400_000;
const USAGE = `Usage: ashlr fleet launch-wait [--hours 6] [--json]
Median and p90 minutes from "- CLAIMED HH:MM" in queue/router-queue.md to the launch row in metrics/jobs.jsonl, for launches in the last N hours. Filler (id ends A, 6+ digits, or Q8) and real work are counted apart. Claim times are local clock time. Read-only; ASHLR_RUNS_DIR overrides ~/.ashlr-runs. Unreadable input exits 2.`;

export interface LaunchWaitGroup { count: number; median_minutes: number | null; p90_minutes: number | null }
export interface LaunchWaitReport {
  schema: typeof FLEET_LAUNCH_WAIT_SCHEMA;
  window_hours: number;
  filler: LaunchWaitGroup;
  real: LaunchWaitGroup;
}

/** Nearest-rank percentile of an ascending list. */
function pct(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : null;
}
const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
function group(waits: number[]): LaunchWaitGroup {
  const s = [...waits].sort((a, b) => a - b);
  return { count: s.length, median_minutes: round(pct(s, 0.5)), p90_minutes: round(pct(s, 0.9)) };
}

/** Claim clock times (minutes after midnight) per job id; a job may be claimed more than once. */
function claims(queue: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of queue.split(/\r?\n/)) {
    const m = /^\s*-\s*CLAIMED\s+(\d{1,2}):(\d{2})\s+.*?\b(RQ-[A-Za-z0-9_-]+)/.exec(line);
    if (!m || +m[1]! > 23 || +m[2]! > 59) continue;
    out.set(m[3]!, [...(out.get(m[3]!) ?? []), +m[1]! * 60 + +m[2]!]);
  }
  return out;
}

export function fleetLaunchWait(queue: string, jobs: string, hours = 6, now = Date.now()): LaunchWaitReport {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const claimed = claims(queue);
  const seen = new Set<string>();
  const filler: number[] = [], real: number[] = [];
  for (const line of jobs.split(/\r?\n/)) {
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object' || r.event !== 'launch') continue;
    const id = [r.job, r.job_id, r.id].find((v): v is string => typeof v === 'string' && v !== '');
    const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (!id || !Number.isFinite(at) || at > now || at < now - hours * 3_600_000 || seen.has(id)) continue;
    const times = claimed.get(id);
    if (!times) continue;
    seen.add(id);
    const d = new Date(at);
    // Latest occurrence of each claim clock time at or before the launch; the closest claim wins.
    const waits = times.map(t => {
      const claimAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, t).getTime();
      return (at - (claimAt > at ? claimAt - DAY : claimAt)) / 60_000;
    });
    (isFillerId(id) ? filler : real).push(Math.min(...waits));
  }
  return { schema: FLEET_LAUNCH_WAIT_SCHEMA, window_hours: hours, filler: group(filler), real: group(real) };
}

export interface LaunchWaitReaders { queue(): Promise<string>; jobs(): Promise<string> }
function defaultReaders(): LaunchWaitReaders {
  const root = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');
  return { queue: () => readFile(join(root, 'queue', 'router-queue.md'), 'utf8'), jobs: () => readFile(join(root, 'metrics', 'jobs.jsonl'), 'utf8') };
}

const fmt = (g: LaunchWaitGroup) => g.count ? `median ${g.median_minutes} min, p90 ${g.p90_minutes} min, n=${g.count}` : 'no launches';

export async function cmdFleetLaunchWait(args: string[], readers: LaunchWaitReaders = defaultReaders(), now = Date.now()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let hours = 6, json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--hours' || a.startsWith('--hours=')) {
      const v = a === '--hours' ? args[++i] : a.slice(8);
      hours = v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    } else { console.error(USAGE); return 2; }
  }
  if (!(hours > 0)) { console.error(USAGE); return 2; }
  let report: LaunchWaitReport;
  try { report = fleetLaunchWait(await readers.queue(), await readers.jobs(), hours, now); }
  catch { console.error('Router queue or jobs ledger is unreadable.'); return 2; }
  if (json) console.log(JSON.stringify(report));
  else console.log(`Claim to launch, last ${hours}h\nfiller: ${fmt(report.filler)}\nreal:   ${fmt(report.real)}`);
  return 0;
}
