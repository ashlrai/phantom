import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet leader [--json]\nRead the last 12 leader runs from the last 2000 dispatch log lines. Read-only.';
type Reader = (path: string) => Promise<string>;
export interface FleetLeaderRun { time: string; status: 'ok' | 'failed'; reason: string | null }
export interface FleetLeaderReport {
  schema: 'fleet.leader.v1'; readOnly: true; runs: FleetLeaderRun[];
  failedInRow: number; lastOkAgeSeconds: number | null;
}
export interface FleetLeaderOptions { readEvents?: Reader; readOutput?: Reader; now?: number }

/** The age and streak describe only the retained window, not earlier history. */
export async function readFleetLeader(options: FleetLeaderOptions = {}): Promise<FleetLeaderReport> {
  const base = join(homedir(), '.ashlr-runs');
  const text = await (options.readEvents ?? (path => readFile(path, 'utf8')))(join(base, 'queue', 'dispatch-events.log'));
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const matches = lines.slice(-2000).filter(line => line.includes(' OPUS-LEADER rc=')).slice(-12);
  const runs: FleetLeaderRun[] = [];
  let failedInRow = 0;
  let lastOkMs: number | null = null;
  for (const line of matches) {
    const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) OPUS-LEADER rc=(-?\d+)(?:\s|$)/.exec(line);
    if (!match) throw new Error('Invalid leader event');
    const time = match[1]!;
    const ms = localTimestamp(time).ms;
    if (!Number.isFinite(ms)) throw new Error('Invalid leader time');
    const failed = !/^-?0+$/.test(match[2]!);
    let reason: string | null = null;
    if (failed) {
      failedInRow++;
      const id = time.slice(5, 7) + time.slice(8, 10) + time.slice(11, 13) + time.slice(14, 16);
      try {
        const output = await (options.readOutput ?? (path => readFile(path, 'utf8')))(join(base, 'leader', `opus-run-${id}.out`));
        // Scrub the complete first line before truncation so secret patterns remain detectable.
        const firstLine = sanitizePublicJson(output.split(/\r?\n/, 1)[0] ?? '') as string;
        // eslint-disable-next-line no-control-regex -- keep untrusted output on one plain line.
        reason = firstLine.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, 500) || null;
      } catch { /* A missing output does not erase the recorded failure. */ }
    } else { failedInRow = 0; lastOkMs = ms; }
    runs.push({ time, status: failed ? 'failed' : 'ok', reason });
  }
  const now = options.now ?? Date.now();
  return sanitizePublicJson({ schema: 'fleet.leader.v1', readOnly: true, runs, failedInRow,
    lastOkAgeSeconds: lastOkMs === null || lastOkMs > now ? null : Math.floor((now - lastOkMs) / 1000) }) as FleetLeaderReport;
}

export async function cmdFleetLeader(args: string[], options: FleetLeaderOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  try {
    const report = await readFleetLeader(options);
    if (args.includes('--json')) console.log(JSON.stringify(report));
    else console.log([...report.runs.map(run => `${run.time} ${run.status}: ${run.reason ?? (run.status === 'ok' ? 'none' : 'unknown')}`),
      `failed in a row: ${report.failedInRow}`, `last ok age: ${report.lastOkAgeSeconds === null ? 'unknown' : `${report.lastOkAgeSeconds} seconds`}`].join('\n'));
    return 0;
  } catch {
    const error = 'Leader dispatch log is unreadable or invalid.';
    console.log(args.includes('--json') ? JSON.stringify({ schema: 'fleet.leader.v1', readOnly: true, error }) : error);
    return 2;
  }
}
