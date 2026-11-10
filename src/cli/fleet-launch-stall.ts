import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLaunchStall } from '../core/fleet/launch-stall-read.js';

const USAGE = 'Usage: phm fleet launch-stall [--min <minutes>] [--json]\nReport the latest consecutive queued ticks with no launches. Duration is from the first to the last tick; exit 1 if it exceeds the limit (default 30 minutes), 2 for invalid arguments or unavailable log.';

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
  const report = parseLaunchStall(text, min);
  if (json) console.log(JSON.stringify(report));
  else if (report.startTime !== null) console.log(`Launch stall since ${report.startTime}: ${report.minutes} minutes; queued: ${report.lastQ}; reaped: ${report.lastReap}; limit: ${min} minutes.`);
  else console.log('No current run of queued ticks without launches.');
  return report.stalled ? 1 : 0;
}
