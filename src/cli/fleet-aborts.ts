import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLEET_ABORTS_SCHEMA = 'fleet.aborts.v1';
export const FLEET_ABORTS_TAIL_LINES = 3000;
export const FLEET_ABORTS_WINDOW_MS = 2 * 60 * 60 * 1000;
export const FLEET_ABORTS_BUCKET_MS = 15 * 60 * 1000;
/** abort_push rows in the newest 15 minutes that mean GitHub pushes are failing. */
export const FLEET_ABORTS_PUSH_RED = 3;

export interface FleetAbortsReport {
  schema: typeof FLEET_ABORTS_SCHEMA;
  readOnly: true;
  status: 'ok' | 'red';
  verdict: 'GITHUB_PUSH_FAILING' | null;
  window_minutes: number;
  total: number;
  by_class: Record<string, number>;
  by_lane: Record<string, number>;
  /** Bucket start (UTC, 15 minute) to count. */
  by_bucket: Record<string, number>;
  recent_abort_push: number;
}

/** Reads the last FLEET_ABORTS_TAIL_LINES lines of the jobs ledger. */
export type FleetAbortsReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet aborts [--json]
Count abort_* jobs from the last 2 hours in ~/.ashlr-runs/metrics/jobs.jsonl by class, lane and 15 minute bucket. Read-only.
Prints GITHUB_PUSH_FAILING and exits 1 when abort_push has ${FLEET_ABORTS_PUSH_RED} or more rows in the newest 15 minutes.`;

const UNREADABLE = 'Jobs ledger is unreadable.';

/** Parse 2026-11-04T04:45:15-0500 by adding the colon to the offset; ISO forms pass through. */
export function parseAbortTs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(ms) ? null : ms;
}

function plain(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const text = Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
  return text || 'unknown';
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

const sorted = (map: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

/** Pure: summarize ledger text as of `now` (epoch ms). Bad lines are skipped. */
export function summarizeFleetAborts(text: string, now: number): FleetAbortsReport {
  const byClass: Record<string, number> = {};
  const byLane: Record<string, number> = {};
  const byBucket: Record<string, number> = {};
  let total = 0;
  let recentPush = 0;
  for (const line of text.split('\n').slice(-FLEET_ABORTS_TAIL_LINES)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const fields = row as Record<string, unknown>;
    const cls = typeof fields.class === 'string' ? fields.class.trim() : '';
    const ts = parseAbortTs(fields.ts);
    if (!cls.startsWith('abort_') || ts === null) continue;
    if (ts < now - FLEET_ABORTS_WINDOW_MS || ts > now) continue;
    total++;
    bump(byClass, plain(cls));
    bump(byLane, plain(fields.lane));
    bump(byBucket, new Date(Math.floor(ts / FLEET_ABORTS_BUCKET_MS) * FLEET_ABORTS_BUCKET_MS).toISOString());
    if (cls === 'abort_push' && ts >= now - FLEET_ABORTS_BUCKET_MS) recentPush++;
  }
  const red = recentPush >= FLEET_ABORTS_PUSH_RED;
  return {
    schema: FLEET_ABORTS_SCHEMA,
    readOnly: true,
    status: red ? 'red' : 'ok',
    verdict: red ? 'GITHUB_PUSH_FAILING' : null,
    window_minutes: FLEET_ABORTS_WINDOW_MS / 60000,
    total,
    by_class: sorted(byClass),
    by_lane: sorted(byLane),
    by_bucket: sorted(byBucket),
    recent_abort_push: recentPush,
  };
}

async function tailLines(path: string): Promise<string> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  return lines.slice(-FLEET_ABORTS_TAIL_LINES).join('\n');
}

/** Read-only. The injected reader and clock are the only outside inputs. */
export async function cmdFleetAborts(
  args: string[],
  reader: FleetAbortsReader = tailLines,
  now: () => number = Date.now,
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
  let report: FleetAbortsReport;
  try {
    report = summarizeFleetAborts(await reader(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')), now());
  } catch {
    console.log(json ? JSON.stringify({ schema: FLEET_ABORTS_SCHEMA, readOnly: true, error: UNREADABLE }) : UNREADABLE);
    return 2;
  }
  if (json) console.log(JSON.stringify(report));
  else {
    for (const [cls, n] of Object.entries(report.by_class)) console.log(`${cls} ${n}`);
    if (report.total === 0) console.log('No aborts in the last 2 hours.');
    if (report.verdict) console.log(report.verdict);
  }
  return report.status === 'red' ? 1 : 0;
}
