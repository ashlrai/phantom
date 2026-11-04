import { JOB_LIMIT_MAX, validJobId } from '../core/fleet/job-path-history.js';
import { JOB_BATCH_MAX, jobHistoryBatch } from '../core/fleet/job-history-batch.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-history-batch RQ-ID... [--limit N] [--json]\n'
  + `1–${JOB_BATCH_MAX} distinct exact job ids; --limit is 1–${JOB_LIMIT_MAX} matching commits per id (default 20). `
  + 'One bounded origin/master scan serves every id; empty evidence does not prove a job never landed.';

/** Read-only batch audit of merged bridge commits; never fetches, queues or merges. */
export async function cmdFleetJobHistoryBatch(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenFlags = new Set<string>();
  let limit = 20, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seenFlags.has(arg)) { json = true; seenFlags.add(arg); continue; }
    if (arg === '--limit' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { console.error(usage); return 2; }
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) { console.error(usage); return 2; }
      continue;
    }
    if (arg.startsWith('-') || !validJobId(arg) || seenIds.has(arg) || ids.length >= JOB_BATCH_MAX) {
      console.error(usage); return 2;
    }
    seenIds.add(arg);
    ids.push(arg);
  }
  if (!ids.length) { console.error(usage); return 2; }
  try {
    const result = await jobHistoryBatch(ids, limit);
    const safe = sanitizePublicJson(result) as typeof result;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Resolved origin/master to ${safe.resolvedRef}; scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    for (const job of safe.jobs) {
      if (!job.commits.length) {
        console.log(`${job.jobId}: no matching commits in this bounded scan; this does not prove the job never landed.`);
        continue;
      }
      console.log(`${job.jobId}:${job.matchesTruncated ? ' matching commits exceed the result limit' : ''}`);
      for (const commit of job.commits) {
        console.log(`  ${commit.sha} ${commit.date} ${commit.pr === null ? '#?' : `#${commit.pr}`}`);
      }
      for (const path of job.paths) console.log(`  ${path}`);
    }
    return 0;
  } catch { console.error('error: unable to read job history batch from git'); return 1; }
}
