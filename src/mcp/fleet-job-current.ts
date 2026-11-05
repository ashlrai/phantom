/**
 * fleet_job_current — does a landed fleet job's code still match what
 * origin/master holds? For the newest bridge commit on origin/master whose
 * subject id exactly equals the requested job, this reports the git tree
 * entry (mode, type and object id) each touched path held at that commit
 * versus the entry the pinned current origin/master tree holds now — object
 * evidence a planner can use to avoid recutting code that is still present
 * instead of treating a historical merge as proof. Reuses `jobCurrent`, the
 * same bounded reader as `phm fleet job-current` — never a second scanner —
 * so the MCP answer and the CLI answer cannot drift. The ref is fixed at
 * origin/master; there is deliberately no caller ref, filesystem root or cwd
 * argument.
 *
 * Statuses are object identity, never a correctness or dispatch verdict:
 * unchanged (identical mode/type/oid), changed (a different entry — a later
 * edit, or a file re-created after a landed deletion), absent-now (the
 * commit left an object here; current master has none) and absent-at-both
 * (the commit left none — a landed deletion — and current master still has
 * none, which is consistency evidence, never missing work). The scan is
 * bounded (newest JOB_SCAN_BOUND commits, at most JOB_CURRENT_PATH_BOUND
 * paths compared), so empty or truncated evidence proves only what the
 * bounded scan saw — it does not prove the job never landed.
 */
import { JOB_CURRENT_PATH_BOUND, jobCurrent, type JobCurrentReport } from '../core/fleet/job-current.js';
import { JOB_SCAN_BOUND, validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetJobCurrentArgs {
  /** Exact case-sensitive fleet job id; matched against bridge(…) subjects only. */
  jobId: string;
}

export interface FleetJobCurrentDeps {
  read?: typeof jobCurrent;
}

/**
 * The full JobCurrentReport under the shared evidence envelope: jobId, ref,
 * resolvedRef, scan and path bounds with their truncation flags, the matched
 * commit (or null), the per-status summary and per-path tree entries with
 * mode, type and OID on each side.
 */
export interface FleetJobCurrentV1 extends JobCurrentReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
}

const NOTE = `Bounded object evidence only: for the newest bridge commit on origin/master whose subject id exactly equals this job (inside the newest ${JOB_SCAN_BOUND} commits scanned, newest first), the git tree entry — mode, type and OID — each touched path held at the commit versus the pinned current origin/master tree, comparing at most ${JOB_CURRENT_PATH_BOUND} paths. Empty or truncated evidence proves only what the bounded scan saw — it does not prove the job never landed. unchanged, changed, absent-now and absent-at-both are object identity only: absent-at-both (a landed deletion still absent) is consistency evidence, never missing work, and none of it is a correctness, live lane, dispatch or merge-queue verdict.`;

const JOB_CURRENT_KEYS = new Set(['jobId']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, path, root or cwd) and a missing,
 * non-string or invalid job id are rejected before the git reader runs.
 */
export function parseFleetJobCurrentArgs(args: Record<string, unknown>): FleetJobCurrentArgs | null {
  const jobId = args['jobId'];
  if (Object.keys(args).some(key => !JOB_CURRENT_KEYS.has(key)) ||
    typeof jobId !== 'string' || !validJobId(jobId)) return null;
  return { jobId };
}

/**
 * One bounded current-state read for the exact job id on the fixed ref.
 * Reader failures (missing git, missing ref, unreadable object store)
 * propagate — the server reports them as a sanitized tool error, never as
 * fabricated empty evidence. Commit subjects stay inside the reader; only
 * the report's shas, dates, pr, path names and tree-entry modes/types/OIDs
 * cross this boundary, all passed through the shared public-JSON scrub.
 */
export async function readFleetJobCurrent(input: FleetJobCurrentArgs, deps: FleetJobCurrentDeps = {}): Promise<FleetJobCurrentV1> {
  const report = await (deps.read ?? jobCurrent)(input.jobId);
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    ...report,
  }) as FleetJobCurrentV1;
}
