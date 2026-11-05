/**
 * fleet_job_current_batch — does the landed code for up to JOB_BATCH_MAX
 * fleet jobs still exist on origin/master, compared to one immutable tree?
 * A single bounded log scan answers every requested id at once, so an MCP
 * planner auditing several jobs pays one git read instead of one per id.
 * Reuses the shared jobCurrentBatch reader — never a second scanner — so
 * the MCP answer and the CLI answer cannot drift. The ref is fixed at
 * origin/master; there is deliberately no caller ref, filesystem root or
 * cwd argument.
 *
 * Each job returns its full current-state report: statuses (unchanged,
 * changed, absent-now, absent-at-both) with per-path tree entries (mode,
 * type and OID), omitted-path counts, missing commit and truncation flags.
 * Object identity is evidence only, never a correctness or dispatch verdict,
 * and never permission to recut. The bounded scan (newest JOB_SCAN_BOUND
 * commits, at most JOB_CURRENT_PATH_BOUND paths per job) means empty or
 * truncated results prove only what the scan saw.
 */
import { JOB_BATCH_MAX, JOB_HISTORY_REF } from '../core/fleet/job-history-batch.js';
import { JOB_CURRENT_PATH_BOUND, JOB_SCAN_BOUND, validJobId } from '../core/fleet/job-path-history.js';
import { JOB_CURRENT_BATCH_SCHEMA, jobCurrentBatch, type JobCurrentBatchReport } from '../core/fleet/job-current-batch.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_JOB_CURRENT_BATCH_IDS = JOB_BATCH_MAX;

export interface FleetJobCurrentBatchArgs {
  /** Distinct exact case-sensitive fleet job ids; matched against bridge(…) subjects only. */
  jobIds: string[];
}

export interface FleetJobCurrentBatchDeps {
  read?: typeof jobCurrentBatch;
}

export interface FleetJobCurrentBatchV1 extends JobCurrentBatchReport {
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
}

const NOTE = `Bounded object evidence only: for each requested job, the newest bridge commit on ${JOB_HISTORY_REF} whose subject id exactly equals it (inside the newest ${JOB_SCAN_BOUND} commits scanned, newest first), compared against one immutable tree pinned at invocation. The git tree entry — mode, type and OID — each touched path held at that commit versus the pinned current origin/master tree, comparing at most ${JOB_CURRENT_PATH_BOUND} paths per job. All jobs share the same resolvedRef, so the answers compare against one tree. Empty or truncated evidence proves only what the bounded scan saw — it does not prove a job never landed. unchanged, changed, absent-now and absent-at-both are object identity only: absent-at-both (a landed deletion still absent) is consistency evidence, never missing work, and none of it is a correctness, live lane, dispatch or merge-queue verdict. Object identity is evidence, not proof of correct behavior or permission to recut.`;

const JOB_CURRENT_BATCH_KEYS = new Set(['jobIds']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, path, root, cwd, limit or duplicate
 * ids), a missing, non-array, empty or oversized id list, malformed ids
 * and duplicates are rejected before the git reader runs.
 */
export function parseFleetJobCurrentBatchArgs(args: Record<string, unknown>): FleetJobCurrentBatchArgs | null {
  const jobIds = args['jobIds'];
  if (Object.keys(args).some(key => !JOB_CURRENT_BATCH_KEYS.has(key)) ||
    !Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > MAX_FLEET_JOB_CURRENT_BATCH_IDS) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of jobIds) {
    if (typeof id !== 'string' || !validJobId(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return { jobIds: jobIds as string[] };
}

/**
 * One bounded current-state read for every exact job id on the fixed ref,
 * resolved to an immutable OID first so all answers describe one tree.
 * The reader is called exactly once with the input order preserved.
 * Reader failures (missing git, missing ref, unreadable object store)
 * propagate — the server reports them as a sanitized tool error, never as
 * fabricated empty evidence. Each job's statuses, omitted-path count,
 * missing commit and truncation flags pass through untouched. Only the
 * report's shas, dates, pr, path names and tree-entry OIDs cross this
 * boundary, all passed through the shared public-JSON scrub.
 */
export async function readFleetJobCurrentBatch(input: FleetJobCurrentBatchArgs, deps: FleetJobCurrentBatchDeps = {}): Promise<FleetJobCurrentBatchV1> {
  const report = await (deps.read ?? jobCurrentBatch)(input.jobIds);
  return sanitizePublicJson({
    schemaVersion: JOB_CURRENT_BATCH_SCHEMA, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    ...report,
  }) as FleetJobCurrentBatchV1;
}
