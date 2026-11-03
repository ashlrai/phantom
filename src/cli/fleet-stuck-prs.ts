import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'Usage: ashlr fleet stuck-prs [--min-age 60] --json';
export interface StuckPr { job: string; url: string; repo: string; ageMinutes: number }
export interface FleetStuckPrsDeps {
  /** Returns the raw text of metrics/jobs.jsonl; tests inject a fixture. */
  read?: () => Promise<string>;
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

const defaultRead = () => readFile(join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl'), 'utf8');
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Jobs whose latest outcome is still OPEN and whose first PR url is older than minAge minutes, oldest first. */
export function stuckPrs(jsonl: string, now: number, minAge: number): StuckPr[] {
  const firstUrl = new Map<string, { at: number; url: string; repo: string }>();
  const latest = new Map<string, { at: number; open: boolean }>();
  for (const line of jsonl.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object') continue;
    const job = text(row.job ?? row.job_id ?? row.id), at = Date.parse(text(row.ts));
    if (!job || !Number.isFinite(at)) continue;
    const url = text(row.url ?? row.pr_url);
    const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(url);
    if (match && at < (firstUrl.get(job)?.at ?? Infinity)) firstUrl.set(job, { at, url, repo: text(row.repo) || match[1]! });
    if (row.event === 'outcome') {
      const prior = latest.get(job);
      if (!prior || at >= prior.at) latest.set(job, { at, open: /^open$/i.test(text(row.outcome ?? row.state)) });
    }
  }
  const stuck: StuckPr[] = [];
  for (const [job, { at, url, repo }] of firstUrl) {
    const ageMinutes = Math.floor((now - at) / 60_000);
    if (latest.get(job)?.open && ageMinutes > minAge) stuck.push({ job, url, repo, ageMinutes });
  }
  return stuck.sort((a, b) => b.ageMinutes - a.ageMinutes || a.job.localeCompare(b.job));
}

export async function cmdFleetStuckPrs(args: string[], deps: FleetStuckPrsDeps = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { output(USAGE); return 0; }
  let minAge = 60;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') continue;
    if (arg !== '--min-age') { error(USAGE); return 2; }
    const value = args[++i] ?? '';
    minAge = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(minAge)) { error(USAGE); return 2; }
  }
  let data: string;
  try { data = await (deps.read ?? defaultRead)(); } catch {
    output(JSON.stringify({ v: 1, minAge, stuck: [], error: 'Could not read jobs.jsonl.' }));
    return 1;
  }
  output(JSON.stringify({ v: 1, minAge, stuck: stuckPrs(data, (deps.now ?? Date.now)(), minAge) }));
  return 0;
}
