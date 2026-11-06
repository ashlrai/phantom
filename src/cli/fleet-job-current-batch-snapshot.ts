import { jobCurrentBatchSnapshot, type JobCurrentBatchSnapshotReport } from '../core/fleet/job-current-batch-snapshot.js';
import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { validSnapshotOid } from '../core/fleet/job-overlap-snapshot.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-current-batch-snapshot --at <full-commit-oid> RQ-ID... [--json]\n'
  + `Replay 1–${JOB_BATCH_MAX} distinct job ids at a recorded ancestor of origin/master.`;

export async function cmdFleetJobCurrentBatchSnapshot(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let snapshot: string | undefined, json = false;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--at' && snapshot === undefined) {
      const value = args[++i];
      if (value !== undefined && validSnapshotOid(value)) { snapshot = value; continue; }
      console.error(usage); return 2;
    }
    if (!arg.startsWith('-') && validJobId(arg) && !ids.includes(arg) && ids.length < JOB_BATCH_MAX) {
      ids.push(arg); continue;
    }
    console.error(usage); return 2;
  }
  if (!snapshot || !ids.length) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await jobCurrentBatchSnapshot(snapshot, ids)) as JobCurrentBatchSnapshotReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Replayed snapshot ${safe.requestedSnapshot}; scanned ${safe.scanned} commits (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    console.log(safe.caveat);
    for (const job of safe.jobs) {
      if (!job.commit) { console.log(`${job.jobId}: no matching bridge commit in this bounded scan; this does not prove the job never landed.`); continue; }
      console.log(`${job.jobId}: bridge commit ${job.commit.sha} ${job.commit.date} ${job.commit.pr === null ? '#?' : `#${job.commit.pr}`}${job.matchesTruncated ? ' (older matching commits exist)' : ''}.`);
      for (const entry of job.entries) console.log(`  ${entry.status.padEnd(14)} ${entry.path}`);
      if (job.omittedPaths) console.log(`  ${job.omittedPaths} more paths beyond the ${job.pathBound}-path bound not compared.`);
    }
    const t = safe.totals;
    console.log(`${t.jobs} jobs (${t.matched} matched): ${t.unchanged} unchanged, ${t.changed} changed, ${t.absentNow} absent-now, ${t.absentAtBoth} absent-at-both; ${t.omittedPaths} paths omitted.`);
    return 0;
  } catch { console.error('error: unable to replay job current batch snapshot from git'); return 1; }
}
