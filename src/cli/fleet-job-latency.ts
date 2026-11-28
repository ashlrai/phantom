import { readFile } from 'node:fs/promises';
import { jobsLedgerPath } from '../core/fleet/git-observations.js';
import { jobLatency, mergeQueueLatency, mergeQueueLatencyText } from '../core/fleet/job-latency.js';
export { jobLatency } from '../core/fleet/job-latency.js';

const USAGE = `Usage: phm fleet job-latency [--jobs <jobs.jsonl>] [--json]
Reads metrics/jobs.jsonl under ASHLR_RUNS_DIR or ~/.ashlr-runs (or use --jobs).
git_contention reports explicitly observed checkout and Git operations; missing evidence is null.
See CONTRACT.md for the local observation format.`;

export async function cmdFleetJobLatency(args: string[]): Promise<number> { return command(args, false); }
export const cmdPulseMergeLatency = (args: string[]): Promise<number> => command(args, true);

async function command(args: string[], mergeOnly: boolean): Promise<number> {
  const usage = mergeOnly ? `Usage: phm pulse merge-latency [--jobs <jobs.jsonl>] [--json]
Read-only, all attempts in metrics/jobs.jsonl under ASHLR_RUNS_DIR or ~/.ashlr-runs (or use --jobs).
Stages: publish to ci_start, ci_start to ci_complete, ci_complete to merged, publish to merged.
JSON: pulse.merge-latency.v1; seconds are observed totals, never estimates.
Each job ID must name one attempt. Missing, invalid, repeated or reversed boundaries are unknown.
Outcome MERGED uses mergedAt when supplied, otherwise its event time. Line order does not matter.`
    : USAGE;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path = jobsLedgerPath();
  let json = false, seenPath = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--jobs' && !seenPath && args[i + 1] && !args[i + 1]!.startsWith('--')) { path = args[++i]!; seenPath = true; }
    else { console.error(usage); return 2; }
  }
  try {
    const ledger = await readFile(path, 'utf8');
    const report = mergeOnly ? mergeQueueLatency(ledger) : jobLatency(ledger);
    console.log(json ? JSON.stringify(report) : report.schema === 'pulse.merge-latency.v1' ? mergeQueueLatencyText(report) : JSON.stringify(report, null, 2));
    return 0;
  } catch {
    // jobLatency(null) is the honest unreadable-ledger report (known:false,
    // every boundary unknown); print it like merge-latency does so --json
    // consumers always get the schema on failure, never empty stdout.
    if (mergeOnly) console.log(json ? JSON.stringify(mergeQueueLatency(null)) : 'Merge queue stages: unknown (jobs ledger unreadable).');
    else console.log(JSON.stringify(jobLatency(null), null, json ? undefined : 2));
    console.error('error: unable to read jobs ledger'); return 1;
  }
}
