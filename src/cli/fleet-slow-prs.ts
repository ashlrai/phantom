import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FLEET_ABORTS_TAIL_LINES, parseAbortTs } from './fleet-aborts.js';

export const FLEET_SLOW_PRS_SCHEMA = 'fleet.slow-prs.v1';
export interface FleetSlowPrsReport {
  schema: typeof FLEET_SLOW_PRS_SCHEMA;
  readOnly: true;
  repos: { repo: string; count: number; urls: string[] }[];
}
export type FleetSlowPrsReader = (path: string) => Promise<string>;
const USAGE = `Usage: ashlr fleet slow-prs [--json]
List open PRs at least 30 minutes old relative to the newest ledger timestamp.
Reads only the last 3000 lines of ~/.ashlr-runs/metrics/jobs.jsonl.
One line per repo: owner/repo count URLs. Read-only.`;

/** First pr row opens a URL; newest timestamped outcome sets its state. */
export function summarizeFleetSlowPrs(text: string): FleetSlowPrsReport {
  const opened = new Map<string, { repo: string; ts: number | null }>();
  const outcomes = new Map<string, { ts: number; state: unknown }>();
  let newest = -Infinity;
  for (const line of text.replace(/\n$/, '').split('\n').slice(-FLEET_ABORTS_TAIL_LINES)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const fields = row as Record<string, unknown>;
    const ts = parseAbortTs(fields.ts);
    if (ts !== null) newest = Math.max(newest, ts);
    const url = fields.url;
    if (typeof url !== 'string') continue;
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9]\d*$/.exec(url);
    if (!match) continue;
    if (fields.class === 'pr' && !opened.has(url)) opened.set(url, { repo: match[1]!, ts });
    if (fields.event === 'outcome' && ts !== null && ts >= (outcomes.get(url)?.ts ?? -Infinity)) {
      outcomes.set(url, { ts, state: fields.state });
    }
  }
  const groups = new Map<string, string[]>();
  for (const [url, pr] of opened) {
    const outcome = outcomes.get(url);
    if (pr.ts === null || newest - pr.ts < 30 * 60_000 || (outcome && outcome.state !== 'OPEN')) continue;
    const urls = groups.get(pr.repo) ?? [];
    urls.push(url);
    groups.set(pr.repo, urls);
  }
  return {
    schema: FLEET_SLOW_PRS_SCHEMA, readOnly: true,
    repos: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([repo, urls]) => ({ repo, count: urls.length, urls: urls.sort() })),
  };
}

export async function cmdFleetSlowPrs(
  args: string[],
  readJobs: FleetSlowPrsReader = path => readFile(path, 'utf8'),
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const json = args[0] === '--json';
  try {
    const report = summarizeFleetSlowPrs(await readJobs(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')));
    if (json) console.log(JSON.stringify(report));
    else if (!report.repos.length) console.log('No slow PRs.');
    else for (const group of report.repos) console.log(`${group.repo} ${group.count} ${group.urls.join(' ')}`);
    return 0;
  } catch {
    const error = 'Jobs ledger is unreadable.';
    console.log(json ? JSON.stringify({ schema: FLEET_SLOW_PRS_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
}
