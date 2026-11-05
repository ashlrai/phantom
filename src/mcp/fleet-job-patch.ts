/**
 * fleet_job_patch — the exact bounded patch a fleet job landed on origin/master,
 * for the isolated fleet MCP server. Delegates to the same reader as
 * `phm fleet job-patch` (jobPatch) — never a second git scanner. The ref is
 * fixed by the reader; there is deliberately no caller ref, root or cwd argument.
 *
 * The patch is read-only, bounded evidence of what landed, never a correctness
 * verdict or permission to merge or dispatch. The reader caps the patch itself
 * (`patchTruncated`); this adapter additionally clips to the server byte budget
 * and says so with `outputClipped`, so a clipped patch is never presented as complete.
 */
import { jobPatch, validPatchPath } from '../core/fleet/job-patch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Headroom under the server's 64 KiB cap for JSON escaping and the server-side scrub. */
const OUTPUT_BUDGET_BYTES = 52 * 1024;

export interface FleetJobPatchArgs {
  /** Exact case-sensitive fleet job id. */
  jobId: string;
  /** Optional repository-relative literal path inside the landed commit. */
  path?: string;
}

export interface FleetJobPatchDeps {
  read?: typeof jobPatch;
}

const NOTE = 'Read-only, bounded evidence: the patch of the newest bridge commit on origin/master whose subject id exactly equals this job, found inside a bounded history scan. not-found-in-bounded-scan proves only what that scan saw. patchTruncated means the reader capped the patch; outputClipped means this tool clipped it further to fit the response limit. Neither a correctness verdict nor permission to merge or dispatch.';

const JOB_PATCH_KEYS = new Set(['jobId', 'path']);

/** Unknown keys (cwd, root, ref, ...), bad ids and bad paths are rejected before the reader runs. */
export function parseFleetJobPatchArgs(args: Record<string, unknown>): FleetJobPatchArgs | null {
  const { jobId, path } = args;
  if (Object.keys(args).some(key => !JOB_PATCH_KEYS.has(key)) ||
    typeof jobId !== 'string' || !validJobId(jobId)) return null;
  if (path === undefined) return { jobId };
  if (typeof path !== 'string' || !validPatchPath(path)) return null;
  return { jobId, path };
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Reader failures propagate; the server reports them as sanitized tool errors, never as empty evidence. */
export async function readFleetJobPatch(input: FleetJobPatchArgs, deps: FleetJobPatchDeps = {}) {
  const read = deps.read ?? jobPatch;
  const result = sanitizePublicJson(await read(input.jobId, input.path)) as Awaited<ReturnType<typeof jobPatch>>;
  let report = { ...result, authority: 'none' as const, note: NOTE, outputClipped: false, outputClippedBytes: 0 };
  const originalBytes = Buffer.byteLength(report.patch, 'utf8');
  // Clip on line boundaries until the escaped JSON fits the budget.
  while (jsonBytes(report) > OUTPUT_BUDGET_BYTES && report.patch.length > 0) {
    const over = jsonBytes(report) - OUTPUT_BUDGET_BYTES;
    const cut = Math.max(1, Math.min(report.patch.length, over));
    const kept = report.patch.slice(0, Math.max(0, report.patch.length - cut));
    const patch = kept.slice(0, kept.lastIndexOf('\n') + 1);
    report = { ...report, patch, outputClipped: true };
  }
  if (report.outputClipped) report.outputClippedBytes = originalBytes - Buffer.byteLength(report.patch, 'utf8');
  return report;
}
