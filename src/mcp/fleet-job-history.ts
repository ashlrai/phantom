/**
 * fleet_job_history — which repository paths a fleet job's merged bridge
 * commits touched on origin/master, for the isolated fleet MCP server.
 * Reuses the same bounded git reader as `phm fleet path-history --job` —
 * never a second scanner — so the MCP answer and the CLI answer cannot
 * drift. The ref is fixed at origin/master; there is deliberately no
 * caller ref, filesystem root or cwd argument.
 *
 * Every returned commit is recorded merge evidence, never a live lane,
 * dispatch or merge-queue verdict. The scan is bounded (newest
 * JOB_SCAN_BOUND commits, newest first) and the result is bounded
 * (at most `limit` matching commits), so an empty or truncated result
 * proves only what the bounded scan saw — it does not prove the job
 * never landed.
 */
import { jobPathHistory, JOB_LIMIT_MAX, JOB_SCAN_BOUND, validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_JOB_HISTORY = JOB_LIMIT_MAX;
export const DEFAULT_FLEET_JOB_HISTORY = 20;
/** Fixed scan ref: the planner asks about landed work, so only origin/master counts. */
export const FLEET_JOB_HISTORY_REF = 'origin/master';

export interface FleetJobHistoryArgs {
  /** Exact case-sensitive fleet job id; matched against bridge(…) subjects only. */
  jobId: string;
  /** Matching commits to return; the scan itself is always bounded. */
  limit: number;
}

export interface FleetJobHistoryDeps {
  read?: typeof jobPathHistory;
}

export interface FleetJobHistoryV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  jobId: string;
  ref: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  limit: number;
  matchesTruncated: boolean;
  commits: Array<{ sha: string; date: string; pr: number | null; paths: string[] }>;
  paths: string[];
}

const NOTE = `Bounded recorded merge evidence only: bridge commits on ${FLEET_JOB_HISTORY_REF} whose subject id exactly equals this job, found inside the newest ${JOB_SCAN_BOUND} commits scanned (newest first). An empty or truncated result proves only that nothing matched inside this bounded scan — it does not prove the job never landed. Never a live lane, dispatch or merge-queue verdict.`;

const JOB_HISTORY_KEYS = new Set(['jobId', 'limit']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, path, root or cwd), missing or invalid
 * job ids, and null, non-integer or out-of-range limits are rejected before
 * the git reader runs.
 */
export function parseFleetJobHistoryArgs(args: Record<string, unknown>): FleetJobHistoryArgs | null {
  const jobId = args['jobId'], limit = args['limit'] ?? DEFAULT_FLEET_JOB_HISTORY;
  if (Object.keys(args).some(key => !JOB_HISTORY_KEYS.has(key)) ||
    typeof jobId !== 'string' || !validJobId(jobId) ||
    args['limit'] === null ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_JOB_HISTORY) return null;
  return { jobId, limit };
}

/**
 * One bounded scan for the exact job id on the fixed ref. Reader failures
 * (missing git, missing ref, unreadable object store) propagate — the server
 * reports them as a sanitized tool error, never as fabricated empty history.
 * Commit subjects stay inside the reader; only sha, date, pr and the touched
 * paths cross this boundary, all passed through the shared public-JSON scrub.
 */
export async function readFleetJobHistory(input: FleetJobHistoryArgs, deps: FleetJobHistoryDeps = {}): Promise<FleetJobHistoryV1> {
  const read = deps.read ?? jobPathHistory;
  const result = await read(input.jobId, FLEET_JOB_HISTORY_REF, input.limit);
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    jobId: result.jobId, ref: result.ref,
    scanBound: result.scanBound, scanned: result.scanned,
    scanMayBeTruncated: result.scanMayBeTruncated,
    limit: result.limit, matchesTruncated: result.matchesTruncated,
    commits: result.commits, paths: result.paths,
  }) as FleetJobHistoryV1;
}
