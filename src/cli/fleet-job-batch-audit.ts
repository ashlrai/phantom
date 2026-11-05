import { jobBatchAudit } from '../core/fleet/job-batch-audit.js';
import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet job-batch-audit RQ-ID... [--json]\n1–${JOB_BATCH_MAX} distinct exact job ids.`;

export async function cmdFleetJobBatchAudit(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg.startsWith('-') || !validJobId(arg) || ids.includes(arg) || ids.length >= JOB_BATCH_MAX) {
      console.error(usage); return 2;
    }
    ids.push(arg);
  }
  if (!ids.length) { console.error(usage); return 2; }
  try {
    const report = sanitizePublicJson(await jobBatchAudit(ids)) as Awaited<ReturnType<typeof jobBatchAudit>>;
    if (json) { console.log(JSON.stringify(report)); return 0; }
    console.log(`Resolved ${report.ref} to ${report.resolvedRef}; scanned ${report.scanned} commits (bound ${report.scanBound}; ${report.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    for (const job of report.jobs) {
      const s = job.summary;
      console.log(`${job.jobId}: ${job.match}; unchanged ${s.unchanged}, changed ${s.changed}, absent-now ${s.absentNow}, absent-at-both ${s.absentAtBoth}; omitted paths ${job.omittedPaths}${job.matchesTruncated ? '; older matches omitted' : ''}.`);
    }
    report.groups.forEach((group, i) => console.log(`Group ${i + 1}: ${group.jobs.join(', ')}; shared paths: ${group.sharedPaths.join(', ') || '(none observed)'}`));
    console.log(`Evidence ${report.incomplete ? 'incomplete' : 'bounded'}: omitted paths and unmatched jobs cannot establish no collision; no match is unknown, not done. Changed or absent objects do not prove a recut is needed; unchanged does not prove correctness.`);
    return 0;
  } catch { console.error('error: unable to read job batch audit from git'); return 1; }
}
