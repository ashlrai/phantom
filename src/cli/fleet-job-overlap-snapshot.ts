import { JOB_LIMIT_MAX, validJobId } from '../core/fleet/job-path-history.js';
import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { JOB_OVERLAP_MIN_IDS } from '../core/fleet/job-overlap.js';
import { jobOverlapSnapshot, validSnapshotOid, type JobOverlapSnapshotResult } from '../core/fleet/job-overlap-snapshot.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-overlap-snapshot --at <full-commit-oid> RQ-ID... [--limit N] [--json]\n'
  + `${JOB_OVERLAP_MIN_IDS}–${JOB_BATCH_MAX} distinct exact job ids; --at is one 40- or 64-character lowercase commit OID that is an ancestor of origin/master; `
  + `--limit is 1–${JOB_LIMIT_MAX} matching commits per id (default 20). `
  + 'Replays one pinned snapshot, so later origin/master moves never change its findings. Only literal paths on landed bridge commits are compared.';

/** Read-only replay of jobOverlap at one recorded commit. Never fetches, queues or merges. */
export async function cmdFleetJobOverlapSnapshot(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenFlags = new Set<string>();
  let snapshot: string | undefined, limit = 20, json = false;
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
  if (snapshot === undefined || ids.length < JOB_OVERLAP_MIN_IDS) { console.error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await jobOverlapSnapshot(snapshot, ids, limit)) as JobOverlapSnapshotResult;
    if (json) { console.log(JSON.stringify(safe)); return 0; }
    console.log(`Replayed snapshot ${safe.requestedSnapshot} (pinned; not current origin/master); scanned ${safe.scanned} commits`
      + ` (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).`);
    for (const job of safe.jobs) {
      console.log(`${job.jobId}: ${job.commits} kept commits, ${job.paths} paths`
        + `${job.matchesTruncated ? '; more matches than --limit kept' : ''}.`);
    }
    if (!safe.sharedPaths.length) {
      console.log('No shared paths observed in this pinned history; that is not proof of safety or permission to dispatch.');
      return 0;
    }
    console.log(`Shared paths (${safe.sharedPaths.length}):`);
    for (const group of safe.sharedPaths) console.log(`  ${group.path}: ${group.jobIds.join(', ')}`);
    return 0;
  } catch { console.error('error: unable to replay job overlap snapshot from git'); return 1; }
}
