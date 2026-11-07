import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getLaneQueueCounts } from '../core/fleet/queue-counts.js';

const usage = 'Usage: phm fleet queue-counts [--root <abs>] [--json]\nPer lane: ready, parked and running jobs plus merges in the last hour (- = no source). Reads <root>/queue and <root>/queue/jobs.jsonl (default ~/.ashlr-runs). Read-only.';

export async function cmdFleetQueueCounts(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root = join(homedir(), '.ashlr-runs'), json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--root' && args[i + 1] && isAbsolute(args[i + 1]!)) root = args[++i]!;
    else { console.error(usage); return 2; }
  }
  const report = await getLaneQueueCounts({ runsDir: root });
  if (json) { console.log(JSON.stringify(report)); return 0; }
  const cell = (n: number | null) => n === null ? '-' : String(n);
  if (report.lanes.length === 0) console.log('queue: empty (no lanes)');
  for (const l of report.lanes) console.log(`${l.lane}  ready ${cell(l.ready)}  parked ${cell(l.parked)}  running ${cell(l.running)}  merges/1h ${cell(l.merges)}`);
  const t = report.totals;
  console.log(`total  ready ${t.ready}  parked ${t.parked}  running ${t.running}  merges/1h ${t.merges}`);
  return 0;
}
