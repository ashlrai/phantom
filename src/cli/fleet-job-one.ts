/** Read-only view of one job. No provider calls, dispatch or writes. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readClassShareJobs } from './fleet-class-share.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-one <id> [--json]';
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
const unknown = 'unknown' as const;
type Value<T> = T | typeof unknown;
export interface JobOneReaders {
  readJobs: () => Promise<string | null>;
  readPrompt: (path: string) => Promise<string | null>;
}
export interface JobOneReport {
  schema: 'fleet.job-one.v1';
  job: string;
  lane: Value<string>;
  model: Value<string>;
  launched_at: Value<string>;
  finish: { at: Value<string>; diff_files: Value<number>; empty: Value<boolean>; wall_s: Value<number> };
  pr_url: Value<string>;
  merge_state: Value<string>;
  merged_at: Value<string>;
  time_to_merge_s: Value<number>;
  first_prompt_line: Value<string>;
}
const defaults: JobOneReaders = { readJobs: readClassShareJobs, readPrompt: path => readFile(path, 'utf8') };
const safeRead = async (read: () => Promise<string | null>) => { try { return await read(); } catch { return null; } };
const text = (v: unknown): Value<string> => typeof v === 'string' && v.length > 0 ? v : unknown;
const count = (v: unknown): Value<number> => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : unknown;

/** Latest launch attempt, then its finish and PR observations in timestamp order.
 * Merge duration is launch to the first recorded MERGED observation (not a GitHub probe).
 */
export async function readJobOne(job: string, readers: JobOneReaders = defaults): Promise<JobOneReport> {
  if (!validId(job)) throw new Error('Invalid job id');
  const [jobs, prompt] = await Promise.all([
    safeRead(readers.readJobs), safeRead(() => readers.readPrompt(join(homedir(), '.ashlr-runs', 'queue', 'prompts', `${job}.md`))),
  ]);
  const result: JobOneReport = { schema: 'fleet.job-one.v1', job, lane: unknown, model: unknown, launched_at: unknown,
    finish: { at: unknown, diff_files: unknown, empty: unknown, wall_s: unknown }, pr_url: unknown,
    merge_state: unknown, merged_at: unknown, time_to_merge_s: unknown,
    first_prompt_line: prompt === null ? unknown : prompt.split(/\r?\n/, 1)[0]! };
  const rows: Record<string, unknown>[] = [];
  for (const line of (jobs ?? '').split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      if ((r.job ?? r.job_id ?? r.id) === job && typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts))) rows.push(r);
    } catch { /* Ignore damaged lines without losing valid observations. */ }
  }
  rows.sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
  const launch = [...rows].reverse().find(r => r.event === 'launch');
  if (launch) { result.lane = text(launch.lane); result.model = text(launch.model); result.launched_at = String(launch.ts); }
  for (const row of rows) {
    if (launch && Date.parse(String(row.ts)) < Date.parse(String(launch.ts))) continue;
    if (row.event === 'finish') result.finish = { at: String(row.ts), diff_files: count(row.diff_files), empty: typeof row.empty === 'boolean' ? row.empty : unknown, wall_s: count(row.wall_s) };
    if (row.event !== 'publish' && row.event !== 'outcome') continue;
    if (typeof row.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(row.url)) result.pr_url = row.url;
    const state = String(row.state ?? row.outcome).toUpperCase();
    if (['OPEN', 'CLOSED', 'MERGED'].includes(state)) result.merge_state = state;
    if (state === 'MERGED' && result.merged_at === unknown) {
      result.merged_at = String(row.ts);
      if (launch) result.time_to_merge_s = (Date.parse(String(row.ts)) - Date.parse(String(launch.ts))) / 1000;
    }
  }
  return sanitizePublicJson(result) as JobOneReport;
}

export async function cmdFleetJobOne(args: string[], readers: JobOneReaders = defaults): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nShow one job's lane, model, launch, finish, PR, merge and first prompt line. Unread files print unknown. Time to merge is seconds from launch to the first recorded merged outcome.`);
    return 0;
  }
  const rest = args.filter(arg => arg !== '--json');
  if (rest.length !== 1 || args.length - rest.length > 1 || !validId(rest[0]!)) { console.error(usage); return 2; }
  const r = await readJobOne(rest[0]!, readers);
  console.log(args.includes('--json') ? JSON.stringify(r) : [
    `Job: ${r.job}`, `Lane: ${r.lane}`, `Model: ${r.model}`, `Launch: ${r.launched_at}`,
    `Finish: ${r.finish.at}; diff files: ${r.finish.diff_files}; empty: ${r.finish.empty}; wall seconds: ${r.finish.wall_s}`,
    `PR: ${r.pr_url}`, `Merge state: ${r.merge_state}; merged at: ${r.merged_at}; seconds from launch to merge: ${r.time_to_merge_s}`,
    `First prompt line: ${r.first_prompt_line}`,
  ].join('\n'));
  return 0;
}
