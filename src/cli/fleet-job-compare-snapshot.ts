import { jobCompareSnapshot, type JobCompareSnapshotReport } from '../core/fleet/job-compare-snapshot.js';
import type { JobCompareEntry } from '../core/fleet/job-compare.js';
import { validSnapshotOid } from '../core/fleet/job-overlap-snapshot.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-compare-snapshot --at <full-commit-oid> RQ-A RQ-B [--json]\n'
  + 'Replays the two-job landed comparison at one recorded commit: --at is one 40- or 64-character lowercase '
  + 'commit OID that is an ancestor of origin/master, and RQ-A RQ-B are exactly two distinct exact job ids. '
  + 'Both newest matching bridge commits and every object read come from the pinned snapshot, so later '
  + 'origin/master moves never change the findings. Replay evidence only: an unmatched job is never identical, '
  + 'and identical objects are not a correctness, safety or merge verdict.';

const short = (oid: string) => oid.slice(0, 12);

function describe(entry: JobCompareEntry['atFirst']): string {
  return entry ? `${entry.mode} ${entry.type} ${short(entry.oid)}` : 'absent';
}

function printText(report: JobCompareSnapshotReport): void {
  console.log(`Replayed snapshot ${report.requestedSnapshot} (pinned; not current origin/master); scanned ${report.scanned} commits`
    + ` (bound ${report.scanBound}; ${report.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
  for (const job of report.jobs) {
    if (!job.commit) {
      console.log(`${job.jobId}: unmatched at the pinned snapshot; no matching bridge commit in this bounded scan.`
        + ' Not identical; this does not prove the job never landed.');
      continue;
    }
    console.log(`${job.jobId}: bridge commit ${job.commit.sha} ${job.commit.date} ${job.commit.pr === null ? '#?' : `#${job.commit.pr}`}`
      + `${job.matchesTruncated ? ' (older matching commits exist)' : ''}.`);
    if (job.omittedPaths) console.log(`  ${job.omittedPaths} more paths beyond the ${job.pathBound}-path bound not compared.`);
  }
  if (!report.comparable) {
    console.log(`Not compared: ${report.unmatched.join(', ')} unmatched at the pinned snapshot.`
      + ' Unmatched jobs are never reported as identical.');
  } else {
    const t = report.totals;
    console.log(`Compared ${t.shared} shared literal paths: ${t.identical} identical, ${t.different} different,`
      + ` ${t.bothAbsent} both-absent.`);
    if (!report.sharedPathsComplete) {
      console.log('Shared list is bounded by omitted paths; absence from it does not prove disjointness.');
    }
    for (const entry of report.entries) {
      console.log(`  ${entry.status.padEnd(12)} ${entry.path}  [${describe(entry.atFirst)}] vs [${describe(entry.atSecond)}]`);
    }
  }
  console.log(report.caveat);
}

/** Read-only replay of jobCompare at one recorded commit. Never fetches, queues or merges. */
export async function cmdFleetJobCompareSnapshot(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const seenFlags = new Set<string>();
  const ids: string[] = [];
  let snapshot: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seenFlags.has(arg)) { json = true; seenFlags.add(arg); continue; }
    if (arg === '--at' && !seenFlags.has(arg)) {
      seenFlags.add(arg);
      const value = args[++i];
      if (value === undefined || !validSnapshotOid(value)) { console.error(usage); return 2; }
      snapshot = value;
      continue;
    }
    if (!arg.startsWith('-') && validJobId(arg) && !ids.includes(arg) && ids.length < 2) { ids.push(arg); continue; }
    console.error(usage); return 2;
  }
  if (snapshot === undefined || ids.length !== 2) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await jobCompareSnapshot(snapshot, ids[0]!, ids[1]!)) as JobCompareSnapshotReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    printText(safe);
    return 0;
  } catch { console.error('error: unable to replay job compare snapshot from git'); return 1; }
}
