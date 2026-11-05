import { JOB_CURRENT_PATH_BOUND, type JobCurrentReport } from '../core/fleet/job-current.js';
import { jobCurrentBatch, type JobCurrentBatchReport } from '../core/fleet/job-current-batch.js';
import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-current-batch RQ-ID... [--json]\n'
  + `1–${JOB_BATCH_MAX} distinct exact job ids; one pinned origin/master snapshot and one shared bounded log scan `
  + `serve every id (up to ${JOB_CURRENT_PATH_BOUND} compared paths each). Evidence, never a correctness verdict.`;

function printJob(job: JobCurrentReport): void {
  if (!job.commit) {
    console.log(`${job.jobId}: no matching bridge commit in this bounded scan; this does not prove the job never landed.`);
    return;
  }
  console.log(`${job.jobId}: bridge commit ${job.commit.sha} ${job.commit.date} ${job.commit.pr === null ? '#?' : `#${job.commit.pr}`}`
    + `${job.matchesTruncated ? ' (older matching commits exist)' : ''}.`);
  for (const entry of job.entries) console.log(`  ${entry.status.padEnd(14)} ${entry.path}`);
  if (job.omittedPaths) console.log(`  ${job.omittedPaths} more paths beyond the ${job.pathBound}-path bound not compared.`);
}

/** Read-only recut audit over one immutable origin/master snapshot; never fetches, mutates or merges. */
export async function cmdFleetJobCurrentBatch(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  const seen = new Set<string>();
  let json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg.startsWith('-') || !validJobId(arg) || seen.has(arg) || ids.length >= JOB_BATCH_MAX) {
      console.error(usage); return 2;
    }
    seen.add(arg);
    ids.push(arg);
  }
  if (!ids.length) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await jobCurrentBatch(ids)) as JobCurrentBatchReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Resolved ${safe.ref} to ${safe.resolvedRef}; scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    for (const job of safe.jobs) printJob(job);
    const t = safe.totals;
    console.log(`${t.jobs} jobs (${t.matched} with a bridge commit): ${t.unchanged} unchanged, ${t.changed} changed,`
      + ` ${t.absentNow} absent-now, ${t.absentAtBoth} absent-at-both — evidence only, not a behavior verdict.`);
    return 0;
  } catch { console.error('error: unable to read job current batch from git'); return 1; }
}
