import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';

const USAGE = 'Usage: phm fleet launch-stall [--min <minutes>] [--json]\nReport the latest consecutive queued ticks with no launches. Duration is from the first to the last tick; exit 1 if it exceeds the limit (default 30 minutes), 2 for invalid arguments or unavailable log.';

export interface LaunchStallReport {
  startTime: string | null;
  minutes: number | null;
  lastQ: number | null;
  lastReap: number | null;
  min: number;
  stalled: boolean;
}

export async function cmdFleetLaunchStall(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let min = 30, json = false, seenMin = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--min' && !seenMin && args[i + 1] && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(args[i + 1]!)) {
      min = Number(args[++i]); seenMin = true;
      if (!Number.isFinite(min)) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  let text: string;
  try { text = await readFile(join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'dispatchd.log'), 'utf8'); }
  catch { console.error('Unable to read dispatchd.log.'); return 2; }
  let start: { at: string; ms: number } | null = null;
  let last: { ms: number; q: number; reap: number } | null = null;
  for (const line of text.split('\n')) {
    if (!/\btick run=/.test(line)) continue;
    const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) tick run=\{.*\} q=(\d+) launched=(\d+) reap=(\d+)(?:\s|$)/.exec(line);
    const stamp = match ? localTimestamp(match[1]!) : null;
    const q = match ? Number(match[2]) : NaN, launched = match ? Number(match[3]) : NaN, reap = match ? Number(match[4]) : NaN;
    if (!stamp || !Number.isFinite(stamp.ms) || ![q, launched, reap].every(Number.isSafeInteger) || q === 0 || launched !== 0) {
      start = null; last = null; continue;
    }
    if (last && stamp.ms < last.ms) start = null;
    start ??= stamp;
    last = { ms: stamp.ms, q, reap };
  }
  const minutes = start && last ? (last.ms - start.ms) / 60_000 : null;
  const report: LaunchStallReport = { startTime: start?.at ?? null, minutes, lastQ: last?.q ?? null, lastReap: last?.reap ?? null, min, stalled: minutes !== null && minutes > min };
  if (json) console.log(JSON.stringify(report));
  else if (start && last) console.log(`Launch stall since ${start.at}: ${minutes} minutes; queued: ${last.q}; reaped: ${last.reap}; limit: ${min} minutes.`);
  else console.log('No current run of queued ticks without launches.');
  return report.stalled ? 1 : 0;
}
