import { JOB_CURRENT_PATH_BOUND } from '../core/fleet/job-current.js';
import { jobCurrentSnapshot, type JobCurrentSnapshotReport } from '../core/fleet/job-current-snapshot.js';
import { validSnapshotOid } from '../core/fleet/job-overlap-snapshot.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-current-snapshot --at <full-commit-oid> RQ-ID [--json]\n'
  + 'Replays the job-current audit at one recorded commit: --at is one 40- or 64-character lowercase commit OID '
  + 'that is an ancestor of origin/master, and RQ-ID is exactly one exact job id. '
  + `Each touched path (up to ${JOB_CURRENT_PATH_BOUND}) is compared between the newest matching bridge commit `
  + 'and the pinned snapshot, so later origin/master moves never change the findings. '
  + 'Evidence, never a correctness verdict; absent-at-both does not mean missing work.';

/** Read-only replay of jobCurrent at one recorded commit. Never fetches, queues or merges. */
export async function cmdFleetJobCurrentSnapshot(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const seenFlags = new Set<string>();
  let snapshot: string | undefined, job: string | undefined, json = false;
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
    if (!arg.startsWith('-') && job === undefined && validJobId(arg)) { job = arg; continue; }
    console.error(usage); return 2;
  }
  if (snapshot === undefined || job === undefined) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await jobCurrentSnapshot(snapshot, job)) as JobCurrentSnapshotReport;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Replayed snapshot ${safe.requestedSnapshot} (pinned; not current origin/master); scanned ${safe.scanned} commits`
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
      + ' — object identity is replay evidence only, not a behavior verdict.');
    return 0;
  } catch { console.error('error: unable to replay job current snapshot from git'); return 1; }
}
