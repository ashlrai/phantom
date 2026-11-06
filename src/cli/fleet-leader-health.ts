import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';

const usage = 'Usage: ashlr fleet leader-health [--json]\nRead leader failures, hours since success, and last bet time. Unknown means no evidence. Exit 1 after 2 failures in a row.';

export interface FleetLeaderHealth {
  schema: 'fleet.leader-health.v1';
  source: 'read' | 'unknown';
  consecutiveFailures: number | null;
  hoursSinceLastSuccess: number | null;
  lastBetAt: string | null;
  cause: string | null;
}
export interface FleetLeaderHealthOptions {
  /** Reads only the dispatch log; null or a rejection means unknown. */
  readEvents?: (path: string) => Promise<string | null>;
  /** Reads the newest opus-run-*.out in the supplied leader directory. */
  readLatestOutput?: (directory: string) => Promise<string | null>;
  now?: number;
}

async function readLatestOutput(directory: string): Promise<string | null> {
  const files = await Promise.all((await readdir(directory))
    .filter(name => /^opus-run-.*\.out$/.test(name))
    .map(async name => ({ path: join(directory, name), info: await stat(join(directory, name)) })));
  const newest = files.filter(file => file.info.isFile())
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || b.path.localeCompare(a.path))[0];
  return newest ? readFile(newest.path, 'utf8') : null;
}

/** Read-only health from log order. Unrelated events do not break the Opus streak. */
export async function readFleetLeaderHealth(opts: FleetLeaderHealthOptions = {}): Promise<FleetLeaderHealth> {
  const result: FleetLeaderHealth = { schema: 'fleet.leader-health.v1', source: 'unknown',
    consecutiveFailures: null, hoursSinceLastSuccess: null, lastBetAt: null, cause: null };
  let text: string | null;
  try {
    text = await (opts.readEvents ?? (path => readFile(path, 'utf8')))(
      join(homedir(), '.ashlr-runs', 'queue', 'dispatch-events.log'));
  } catch { return result; }
  if (text === null) return result;
  result.source = 'read';
  const now = opts.now ?? Date.now();
  let lastFailed = false;
  for (const line of text.split(/\r?\n/)) {
    const row = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (OPUS-LEADER|LEADER)(?: (.*))?$/.exec(line);
    if (!row) continue;
    const stamp = localTimestamp(row[1]!);
    if (!Number.isFinite(stamp.ms) || stamp.ms > now) continue;
    const fields = row[3] ?? '';
    if (row[2] === 'LEADER') {
      if (/(?:^|\s)bets=[1-9]\d*(?=\s|$)/.test(fields)) result.lastBetAt = new Date(stamp.ms).toISOString();
      continue;
    }
    const rc = /(?:^|\s)rc=(-?\d+)(?=\s|$)/.exec(fields);
    lastFailed = rc !== null && Number(rc[1]) !== 0;
    // An incomplete outcome cannot establish a healthy streak.
    if (!rc) { result.consecutiveFailures = null; continue; }
    if (Number(rc[1]) === 0) {
      result.consecutiveFailures = 0;
      result.hoursSinceLastSuccess = (now - stamp.ms) / 3_600_000;
    } else {
      result.consecutiveFailures = (result.consecutiveFailures ?? 0) + 1;
    }
  }
  if (lastFailed) {
    try {
      const output = await (opts.readLatestOutput ?? readLatestOutput)(join(homedir(), '.ashlr-runs', 'leader'));
      const firstLine = output?.split(/\r?\n/, 1)[0];
      result.cause = firstLine?.includes('OAuth session expired')
        ? 'Claude sign-in expired: run claude login' : firstLine?.slice(0, 160) || null;
    } catch { /* Missing output leaves the cause unknown, without hiding log evidence. */ }
  }
  return result;
}

export async function cmdFleetLeaderHealth(args: string[], opts: FleetLeaderHealthOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  const report = await readFleetLeaderHealth(opts);
  console.log(args.includes('--json') ? JSON.stringify(report) :
    `Leader failures in a row: ${report.consecutiveFailures ?? 'unknown'}\nHours since last success: ${report.hoursSinceLastSuccess ?? 'unknown'}\nLast bet: ${report.lastBetAt ?? 'unknown'}\nCause: ${report.cause ?? 'unknown'}`);
  return (report.consecutiveFailures ?? 0) >= 2 ? 1 : 0;
}
