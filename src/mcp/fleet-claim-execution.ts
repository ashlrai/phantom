/** Claim execution evidence for the isolated read-only fleet MCP server. */
import { readClaimExecution, type ClaimExecutionDeps } from '../core/fleet/claim-execution-evidence.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const NOTE = "Read-only sanitized claim execution evidence: which live advisory claims have a matching worker process on this computer. RUNNING requires a matched worker; otherwise CLAIMED_NO_WORKER or UNKNOWN. Grants no dispatch, claim or merge authority. Accepts no arguments and never writes.";

/** Reject every extra key before reading any host state. */
export function parseFleetClaimExecutionArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export async function readFleetClaimExecution(deps: ClaimExecutionDeps = {}) {
  const report = await readClaimExecution(deps);
  return sanitizePublicJson({ ...report, note: NOTE });
}
