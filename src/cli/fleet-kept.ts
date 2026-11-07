import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FLEET_ABORTS_TAIL_LINES, parseAbortTs } from './fleet-aborts.js';

export const FLEET_KEPT_SCHEMA = 'fleet.kept.v1';
export const FLEET_KEPT_OLDEST = 3;
const REASONS = ['abort_push', 'abort_pr', 'empty', 'other', 'unknown'] as const;
export type FleetKeptReason = (typeof REASONS)[number];

export interface FleetKeptGroup {
  reason: FleetKeptReason;
  count: number;
  /** Up to 3 ids, oldest first. Ids with no age come last, sorted by name. */
  oldest: string[];
}

export interface FleetKeptReport {
  schema: typeof FLEET_KEPT_SCHEMA;
  readOnly: true;
  kept: number;
  reasons: FleetKeptGroup[];
}

/** Reads one file as text. */
export type FleetKeptReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet kept [--json]
Why worktrees were kept: one line per reason (abort_push, abort_pr, empty, other, unknown) with its count and the ${FLEET_KEPT_OLDEST} oldest job ids. Read-only.
Reads kept_worktrees from ~/.ashlr-runs/queue/status.json and the last ${FLEET_ABORTS_TAIL_LINES} lines of ~/.ashlr-runs/metrics/jobs.jsonl. A job with no row that has a class is unknown.`;
const UNREADABLE = 'Queue status or jobs ledger is unreadable.';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Pure: group kept ids by the class of their newest classed ledger row. */
export function summarizeFleetKept(kept: string[], ledgerText: string): FleetKeptReport {
  const latest = new Map<string, { reason: FleetKeptReason; ts: number }>();
  const wanted = new Set(kept);
  for (const line of ledgerText.split('\n').slice(-FLEET_ABORTS_TAIL_LINES)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const fields = row as Record<string, unknown>;
    const job = fields.job ?? fields.job_id;
    if (typeof job !== 'string' || !wanted.has(job)) continue;
    const cls = typeof fields.class === 'string' ? fields.class.trim() : '';
    if (!cls) continue;
    const ts = parseAbortTs(fields.ts) ?? Number.NaN;
    const before = latest.get(job);
    // Newest wins; rows without a usable ts keep append order.
    if (before && Number.isFinite(before.ts) && Number.isFinite(ts) && ts < before.ts) continue;
    latest.set(job, { reason: cls === 'abort_push' || cls === 'abort_pr' || cls === 'empty' ? cls : 'other', ts });
  }
  const groups = new Map<FleetKeptReason, { id: string; ts: number }[]>(REASONS.map(r => [r, []]));
  for (const id of kept) {
    const hit = latest.get(id);
    groups.get(hit?.reason ?? 'unknown')!.push({ id, ts: hit?.ts ?? Number.NaN });
  }
  const age = (ts: number) => (Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY);
  return {
    schema: FLEET_KEPT_SCHEMA,
    readOnly: true,
    kept: kept.length,
    reasons: REASONS.flatMap(reason => {
      const rows = groups.get(reason)!;
      if (rows.length === 0) return [];
      rows.sort((a, b) => age(a.ts) - age(b.ts) || a.id.localeCompare(b.id));
      return [{ reason, count: rows.length, oldest: rows.slice(0, FLEET_KEPT_OLDEST).map(r => r.id) }];
    }),
  };
}

/** Parse queue/status.json text into kept ids; throws when the list is missing, malformed or unsafe. */
export function parseKeptWorktrees(statusText: string): string[] {
  const status: unknown = JSON.parse(statusText);
  const list = (status as { kept_worktrees?: unknown } | null)?.kept_worktrees;
  if (!Array.isArray(list) || !list.every(id => typeof id === 'string' && SAFE_ID.test(id))) throw new Error('Invalid kept list');
  return [...new Set<string>(list)];
}

/** Read-only. The two injected readers are the only filesystem operations. */
export async function cmdFleetKept(
  args: string[],
  readStatus: FleetKeptReader = path => readFile(path, 'utf8'),
  readJobs: FleetKeptReader = path => readFile(path, 'utf8'),
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const json = args[0] === '--json';
  try {
    const kept = parseKeptWorktrees(await readStatus(join(homedir(), '.ashlr-runs', 'queue', 'status.json')));
    const report = summarizeFleetKept(kept, await readJobs(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')));
    if (json) console.log(JSON.stringify(report));
    else if (report.reasons.length === 0) console.log('No kept worktrees.');
    else for (const g of report.reasons) console.log(`${g.reason} ${g.count} ${g.oldest.join(' ')}`);
    return 0;
  } catch {
    console.log(json ? JSON.stringify({ schema: FLEET_KEPT_SCHEMA, readOnly: true, error: UNREADABLE }) : UNREADABLE);
    return 2;
  }
}
