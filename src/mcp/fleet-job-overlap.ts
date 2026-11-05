import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { JOB_OVERLAP_MIN_IDS, jobOverlap, type JobOverlapResult } from '../core/fleet/job-overlap.js';
import { JOB_LIMIT_MAX, validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetJobOverlapArgs {
  jobIds: string[];
  limit: number;
}

export interface FleetJobOverlapV1 extends JobOverlapResult {
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** Validate before invoking the reader; the low-level MCP server does not enforce its schema. */
export function parseFleetJobOverlapArgs(args: Record<string, unknown>): FleetJobOverlapArgs | null {
  const { jobIds } = args;
  const limit = args['limit'] === undefined ? 20 : args['limit'];
  if (Object.keys(args).some(key => key !== 'jobIds' && key !== 'limit') ||
    !Array.isArray(jobIds) || jobIds.length < JOB_OVERLAP_MIN_IDS || jobIds.length > JOB_BATCH_MAX ||
    !jobIds.every(id => typeof id === 'string' && validJobId(id)) || new Set(jobIds).size !== jobIds.length ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) return null;
  return { jobIds: jobIds as string[], limit };
}

/** Reuse the core's single bounded read and preserve its incomplete-evidence note. */
export async function readFleetJobOverlap(input: FleetJobOverlapArgs, deps: { read?: typeof jobOverlap } = {}): Promise<FleetJobOverlapV1> {
  const result = await (deps.read ?? jobOverlap)(input.jobIds, input.limit);
  return sanitizePublicJson({ ...result, snapshotKind: 'local-persisted', authority: 'none', generatedAt: new Date().toISOString() }) as FleetJobOverlapV1;
}
