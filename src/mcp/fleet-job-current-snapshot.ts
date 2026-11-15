/**
 * fleet_job_current_snapshot — replay a landed fleet job's current-state
 * audit at one recorded immutable commit. A CLI planner records
 * `phm fleet job-current-snapshot --at <oid>` output; this tool lets an MCP
 * agent reproduce exactly that evidence after origin/master has moved on, so
 * a recut decision is never made against a different tree than the planner
 * saw. Reuses `jobCurrentSnapshot`, the same reader as the CLI — never a
 * second scanner — so the MCP replay and the CLI replay cannot drift. The
 * snapshot must be a full lowercase 40- or 64-character commit OID that is an
 * ancestor of origin/master (the reader verifies both with argument-array
 * git calls before any scan); there is deliberately no caller ref,
 * filesystem root or cwd argument.
 *
 * The answer is replay evidence, not a live reading: `requestedSnapshot` is
 * the pinned commit every log and ls-tree read used, and `resolvedRef`
 * echoes it. origin/master may hold different objects now — later pushes
 * never change these findings. Statuses are object identity, never a
 * correctness or dispatch verdict: unchanged (identical mode/type/oid),
 * changed (a different entry — a later edit, or a file re-created after a
 * landed deletion), absent-now (the commit left an object here; the pinned
 * snapshot has none) and absent-at-both (the commit left none — a landed
 * deletion — and the snapshot still has none, which is consistency evidence,
 * never missing work). The scan stays bounded (newest JOB_SCAN_BOUND
 * commits, at most JOB_CURRENT_PATH_BOUND paths compared), so empty or
 * truncated evidence proves only what the bounded scan saw — it does not
 * prove the job never landed.
 */
import { JOB_CURRENT_PATH_BOUND } from '../core/fleet/job-current.js';
import { jobCurrentSnapshot, type JobCurrentSnapshotReport } from '../core/fleet/job-current-snapshot.js';
import { validSnapshotOid } from '../core/fleet/job-overlap-snapshot.js';
import { JOB_SCAN_BOUND, validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetJobCurrentSnapshotArgs {
  /** Exact case-sensitive fleet job id; matched against bridge(…) subjects only. */
  jobId: string;
  /** Full lowercase 40- or 64-character commit OID, verified as an origin/master ancestor before any scan. */
  snapshot: string;
}

export interface FleetJobCurrentSnapshotDeps {
  read?: typeof jobCurrentSnapshot;
}

/**
 * The full JobCurrentSnapshotReport under the shared evidence envelope:
 * jobId, resolvedRef (the pinned snapshot OID), requestedSnapshot, the
 * replay caveat, scan and path bounds with their truncation flags, the
 * matched commit (or null), the per-status summary and per-path tree entries
 * with mode, type and OID on each side.
 */
export interface FleetJobCurrentSnapshotV1 extends JobCurrentSnapshotReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
}

const NOTE = `Bounded replay evidence only: for the newest bridge commit on origin/master whose subject id exactly equals this job (inside the newest ${JOB_SCAN_BOUND} commits scanned at the pinned snapshot, newest first), the git tree entry — mode, type and OID — each touched path held at the commit versus the pinned requestedSnapshot tree, comparing at most ${JOB_CURRENT_PATH_BOUND} paths. This is not current live origin/master: later pushes never change these findings. Empty or truncated evidence proves only what the bounded scan saw — it does not prove the job never landed. unchanged, changed, absent-now and absent-at-both are object identity only: absent-at-both (a landed deletion still absent) is consistency evidence, never missing work, and none of it is a correctness, live lane, dispatch or merge-queue verdict.`;

const JOB_CURRENT_SNAPSHOT_KEYS = new Set(['jobId', 'snapshot']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, path, root or cwd), a missing,
 * non-string or invalid job id, and a missing, non-string or non-full
 * lowercase 40/64-character snapshot OID are rejected before the git reader
 * runs.
 */
export function parseFleetJobCurrentSnapshotArgs(args: Record<string, unknown>): FleetJobCurrentSnapshotArgs | null {
  const jobId = args['jobId'];
  const snapshot = args['snapshot'];
  if (Object.keys(args).some(key => !JOB_CURRENT_SNAPSHOT_KEYS.has(key)) ||
    typeof jobId !== 'string' || !validJobId(jobId) ||
    typeof snapshot !== 'string' || !validSnapshotOid(snapshot)) return null;
  return { jobId, snapshot };
}

/**
 * One bounded replay of the current-state audit for the exact job id at the
 * pinned commit. Reader failures (invalid or non-ancestor OID, missing git,
 * missing ref, unreadable object store) propagate — the server reports them
 * as a sanitized tool error, never as fabricated empty evidence. Commit
 * subjects stay inside the reader; only the report's shas, dates, pr, path
 * names and tree-entry modes/types/OIDs cross this boundary, all passed
 * through the shared public-JSON scrub.
 */
export async function readFleetJobCurrentSnapshot(input: FleetJobCurrentSnapshotArgs, deps: FleetJobCurrentSnapshotDeps = {}): Promise<FleetJobCurrentSnapshotV1> {
  const report = await (deps.read ?? jobCurrentSnapshot)(input.snapshot, input.jobId);
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    ...report,
  }) as FleetJobCurrentSnapshotV1;
}
