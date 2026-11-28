import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getLaneQueueCounts } from '../core/fleet/queue-counts.js';

const usage = 'Usage: phm fleet queue-counts [--root <abs>] [--json]\nPer lane: ready, parked (blocked, with reasons), running, oldest wait and merges in the last hour. Stale = parked on gates that are already merged. Wait includes ready and parked jobs and restarts at each re-arrival; unknown means missing evidence, such as a silent requeue. Reads <root>/queue and <root>/metrics/jobs.jsonl (default ASHLR_RUNS_DIR or ~/.ashlr-runs). Read-only.';

export async function cmdFleetQueueCounts(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--root' && args[i + 1] && isAbsolute(args[i + 1]!)) root = args[++i]!;
    else { console.error(usage); return 2; }
  }
  const report = await getLaneQueueCounts({ runsDir: root });
  if (json) { console.log(JSON.stringify(report)); return 0; }
  const cell = (n: number | null) => n === null ? 'unknown' : String(n);
  if (report.lanes.length === 0) console.log('No lanes found.');
  const why = (rs: readonly { reason: string; count: number }[]) => rs.length ? `  blocked by ${rs.map(r => `${r.reason} ${r.count}`).join(', ')}` : '';
  for (const l of report.lanes) console.log(`${l.lane}  ready ${cell(l.ready)}  parked ${cell(l.parked)}${why(l.blockedReasons)}${l.stale ? `  stale ${l.stale}` : ''}  running ${cell(l.running)}  oldest wait ${l.oldestWaitSeconds === null ? 'unknown' : `${l.oldestWaitSeconds} seconds`}  merges in last hour ${cell(l.merges)}`);
  const t = report.totals;
  console.log(`total  ready ${cell(t.ready)}  parked ${cell(t.parked)}  running ${cell(t.running)}  merges in last hour ${cell(t.merges)}`);
  for (const note of report.notes) console.log(`note: ${note}`);
  return 0;
}
