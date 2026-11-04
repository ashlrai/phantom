import { JOB_CURRENT_PATH_BOUND, jobCurrent, type JobCurrentReport } from '../core/fleet/job-current.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-current RQ-ID [--json]\n'
  + 'Object evidence for one exact job id: what the newest matching bridge commit left at each touched path '
  + `vs current origin/master (up to ${JOB_CURRENT_PATH_BOUND} paths). Evidence, never a correctness verdict.`;

/** Read-only landed-work audit; never fetches, mutates or merges. */
export async function cmdFleetJobCurrent(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let job: string | undefined, json = false;
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg === '--json' && !seen.has(arg)) { json = true; seen.add(arg); continue; }
    if (!arg.startsWith('-') && job === undefined && validJobId(arg)) { job = arg; continue; }
    console.error(usage); return 2;
  }
  if (!job) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await jobCurrent(job)) as JobCurrentReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Resolved ${safe.ref} to ${safe.resolvedRef}; scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    if (!safe.commit) {
      console.log('No matching bridge commit in this bounded scan; this does not prove the job never landed.');
      return 0;
    }
    console.log(`Newest bridge commit ${safe.commit.sha} ${safe.commit.date} ${safe.commit.pr === null ? '#?' : `#${safe.commit.pr}`}`
      + `${safe.matchesTruncated ? ' (older matching commits exist)' : ''}.`);
    for (const entry of safe.entries) console.log(`  ${entry.status.padEnd(14)} ${entry.path}`);
    if (safe.omittedPaths) console.log(`  ${safe.omittedPaths} more paths beyond the ${safe.pathBound}-path bound not compared.`);
    const s = safe.summary;
    console.log(`${s.unchanged} unchanged, ${s.changed} changed, ${s.absentNow} absent-now, ${s.absentAtBoth} absent-at-both`
      + ' — object identity is evidence only, not a behavior verdict.');
    return 0;
  } catch { console.error('error: unable to read job current state from git'); return 1; }
}
