/** Offline accounting only; never changes dispatch or merge authority. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneClassShare } from '../core/fleet/lane-class-share.js';
import { readJobsTail } from '../core/fleet/report-ledger.js';

const usage = `ashlr fleet class-share [--hours N] [--json]
Read-only event totals in the trailing window. Missing finishes contribute zero known tokens; PRs dedupe by URL.`;

/** Retained tail bound for the class-share ledger read. */
const CLASS_SHARE_JOBS_TAIL_BYTES = 32 * 1024 * 1024;

/** Newest CLASS_SHARE_JOBS_TAIL_BYTES of metrics/jobs.jsonl; any read failure throws. */
export async function readClassShareJobs(): Promise<string> {
  const read = await readJobsTail(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), CLASS_SHARE_JOBS_TAIL_BYTES);
  if (read.text === null) throw new Error('Unavailable metrics');
  return read.text;
}

export async function cmdFleetClassShare(args: string[], readJobs = readClassShareJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  let hours = 3;
  let json = false;
  let hasHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !hasHours && /^\d+(?:\.\d+)?$/.test(args[i + 1] ?? '')) {
      hours = Number(args[++i]); hasHours = true;
      if (!Number.isFinite(hours) || hours <= 0) return 2;
    } else return 2;
  }
  try {
    const report = laneClassShare(await readJobs(), hours, now);
    console.log(json ? JSON.stringify(report) : ['lane class launches tokens_total prs_opened prs_merged',
      ...report.rows.map(r => `${r.lane} ${r.class} ${r.launches} ${r.tokens_total} ${r.prs_opened} ${r.prs_merged}`),
      `Malformed rows: ${report.malformed}`].join('\n'));
    return 0;
  } catch {
    console.error('fleet class-share: metrics unavailable');
    return 1;
  }
}
