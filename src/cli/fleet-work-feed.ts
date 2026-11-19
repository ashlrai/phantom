/** Read-only bus v2 work feed; routing labels grant no authority. */
import { isAbsolute } from 'node:path';
import { readBusWorkFeed, type BusWorkFeedHold } from '../core/agents/bus-work-feed-read.js';
import { WORK_STATUSES, type WorkJob } from '../core/agents/bus-v2-schema.js';

const usage = `Usage: ashlr fleet work-feed [--root <absolute>] [--status <${WORK_STATUSES.join('|')}>] [--claims] [--json] [--help]
Read-only bus v2 work feed; --claims joins live coordination holds. Unknown feed or hold state stays unknown.`;

export async function cmdFleetWorkFeed(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, status: WorkJob['status'] | undefined, json = false, claims = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--claims' && !claims) { claims = true; continue; }
    if (key !== '--root' && key !== '--status') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--status' && status === undefined && WORK_STATUSES.some(item => item === value)) {
      status = value as WorkJob['status'];
    } else { console.error(usage); return 2; }
  }
  if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) { console.error(usage); return 2; }
  const result = readBusWorkFeed({ root, claims });
  if (result.status === 'ok') {
    result.jobs = result.jobs.filter(job => status === undefined || job.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (result.claims) {
      const byJob = new Map<string, BusWorkFeedHold[]>();
      for (const hold of result.claims.holds) {
        const list = byJob.get(hold.jobId) ?? [];
        list.push(hold);
        byJob.set(hold.jobId, list);
      }
      result.claims.holds = result.jobs.flatMap(job => byJob.get(job.id) ?? []);
    }
  }
  if (json) console.log(JSON.stringify(result));
  else {
    if (result.status === 'ok') {
      for (const job of result.jobs) {
        console.log(`${job.id} ${job.status} owner=${job.owner} provider=${job.provider} repo=${job.repo} updated=${new Date(job.updatedAt).toISOString()}`);
      }
      if (result.claims) for (const hold of result.claims.holds) {
        console.log(`held ${hold.jobId} ${hold.claimKey} owner=${hold.owner} until=${new Date(hold.leaseUntil).toISOString()}`);
      }
    }
    const feed = result.status === 'refused' ? `refused:${result.reason}` : result.status;
    const claimsNote = result.status === 'ok' && result.claims
      ? ` claims=${result.claims.source}${result.claims.truncated ? ':truncated' : ''}` : '';
    console.log(`jobs=${result.status === 'ok' ? result.jobs.length : 'unknown'} receipts=${'receipts' in result ? result.receipts : 'unknown'} feed=${feed} as-of=${result.asOf}${claimsNote}`);
  }
  return result.status === 'ok' ? 0 : 1;
}
