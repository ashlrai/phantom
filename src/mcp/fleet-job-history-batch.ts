/**
 * fleet_job_history_batch — which repository paths up to JOB_BATCH_MAX
 * proposed fleet job ids landed on origin/master, for the isolated fleet
 * MCP server. One bounded git-log scan answers every requested id at once,
 * so a planner auditing a batch of proposed jobs pays one history read
 * instead of one scan per id. Reuses the shared `jobHistoryBatch` reader —
 * never a second scanner — so the MCP answer and the CLI answer cannot
 * drift. The ref is fixed at origin/master; there is deliberately no
 * caller ref, filesystem root or cwd argument.
 *
 * Every returned commit is recorded merge evidence, never a live lane,
 * dispatch or merge-queue verdict. The scan is bounded (newest
 * JOB_SCAN_BOUND commits, newest first) and each id keeps at most `limit`
 * matching commits, so an empty or truncated result proves only what the
 * bounded scan saw — it does not prove a job never landed.
 */
import { JOB_BATCH_MAX, JOB_HISTORY_REF, jobHistoryBatch } from '../core/fleet/job-history-batch.js';
import { JOB_LIMIT_MAX, JOB_SCAN_BOUND, validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_JOB_HISTORY_BATCH_IDS = JOB_BATCH_MAX;
export const MAX_FLEET_JOB_HISTORY_BATCH_LIMIT = JOB_LIMIT_MAX;
export const DEFAULT_FLEET_JOB_HISTORY_BATCH_LIMIT = 20;
/** Fixed scan ref: the planner asks about landed work, so only origin/master counts. */
export const FLEET_JOB_HISTORY_BATCH_REF = JOB_HISTORY_REF;

export interface FleetJobHistoryBatchArgs {
  /** Distinct exact case-sensitive fleet job ids; matched against bridge(…) subjects only. */
  jobIds: string[];
  /** Matching commits to keep per id; the scan itself is always bounded. */
  limit: number;
}

export interface FleetJobHistoryBatchDeps {
  read?: typeof jobHistoryBatch;
}

export interface FleetJobHistoryBatchV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  ref: string;
  /** Immutable commit OID the whole audit ran against; the ref may move later. */
  resolvedRef: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  limit: number;
  jobs: Array<{
    jobId: string;
    matchesTruncated: boolean;
    commits: Array<{ sha: string; date: string; pr: number | null; paths: string[] }>;
    paths: string[];
  }>;
}

const NOTE = `Bounded recorded merge evidence only: bridge commits on ${FLEET_JOB_HISTORY_BATCH_REF} whose subject id exactly equals a requested job, all found inside one scan of the newest ${JOB_SCAN_BOUND} commits (newest first). A missing or truncated result proves only that nothing matched inside this bounded scan — it does not prove the job never landed. Never a live lane, dispatch or merge-queue verdict; it never authorizes dispatch or merge.`;

const JOB_HISTORY_BATCH_KEYS = new Set(['jobIds', 'limit']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, path, root or cwd), a missing,
 * oversized or duplicated id list, malformed ids, and null, non-integer or
 * out-of-range limits are rejected before the git reader runs.
 */
export function parseFleetJobHistoryBatchArgs(args: Record<string, unknown>): FleetJobHistoryBatchArgs | null {
  const jobIds = args['jobIds'], limit = args['limit'] ?? DEFAULT_FLEET_JOB_HISTORY_BATCH_LIMIT;
  if (Object.keys(args).some(key => !JOB_HISTORY_BATCH_KEYS.has(key)) ||
    !Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > MAX_FLEET_JOB_HISTORY_BATCH_IDS ||
    args['limit'] === null ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_JOB_HISTORY_BATCH_LIMIT) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of jobIds) {
    if (typeof id !== 'string' || !validJobId(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return { jobIds: jobIds as string[], limit };
}

/**
 * One bounded scan for every exact job id on the fixed ref, resolved to an
 * immutable OID first so the answer describes one tree. Reader failures
 * (missing git, missing ref, unreadable object store) propagate — the
 * server reports them as a sanitized tool error, never as fabricated empty
 * history. Commit subjects stay inside the reader; only sha, date, pr and
 * the touched paths cross this boundary, all passed through the shared
 * public-JSON scrub.
 */
export async function readFleetJobHistoryBatch(input: FleetJobHistoryBatchArgs, deps: FleetJobHistoryBatchDeps = {}): Promise<FleetJobHistoryBatchV1> {
  const read = deps.read ?? jobHistoryBatch;
  const result = await read(input.jobIds, input.limit);
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    ref: FLEET_JOB_HISTORY_BATCH_REF, resolvedRef: result.resolvedRef,
    scanBound: result.scanBound, scanned: result.scanned,
    scanMayBeTruncated: result.scanMayBeTruncated,
    limit: result.limit, jobs: result.jobs,
  }) as FleetJobHistoryBatchV1;
}
