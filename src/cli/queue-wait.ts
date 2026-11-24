import { homedir } from 'node:os';
import { join } from 'node:path';
import { queueWait } from '../core/queue/wait.js';
import { fleetMergeLatency, readMergeEvents } from './fleet-merge-latency.js';

const HELP = `Usage: phm queue wait [--events <file>] [--json]
Show the oldest recorded queued PR, seconds waiting and the current wait reason.
Start here: phm queue wait --json
Reads ~/.ashlr-runs/metrics/merge-events.jsonl; --events selects another local file.
This is recorded evidence, not a live GitHub query. Missing or unclear evidence stays unknown.
JSON: queue.wait.v1, state (queued, empty, unknown), oldestQueued (or null).
Read-only. Required checks and merge-queue rules stay enforced.`;

export async function cmdQueueWait(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(HELP); return 0; }
  let path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--events' && path === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { console.error(HELP); return 2; }
  }
  const now = Date.now();
  const report = queueWait(await fleetMergeLatency(readMergeEvents(path ?? join(homedir(), '.ashlr-runs', 'metrics', 'merge-events.jsonl')), now), now);
  const row = report.oldestQueued;
  console.log(json ? JSON.stringify(report) : row
    ? `${row.repo}#${row.pr}: ${row.waitingSeconds}s queued; waiting on ${row.reason.replaceAll('_', ' ')} (recorded evidence).`
    : report.state === 'empty' ? 'No queued PRs in the recorded evidence.' : 'Queue wait unknown: evidence is missing or unclear.');
  return report.state === 'unknown' ? 1 : 0;
}
