import { buildCommsCutoverReadiness, type CommsCutoverReadinessDeps } from '../comms/cutover-readiness.js';

export function parseFleetCommsReadinessArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

/** Server-owned local evidence; the shared reader owns the state mapping. */
export async function readFleetCommsReadiness(deps: CommsCutoverReadinessDeps = {}) {
  const report = await buildCommsCutoverReadiness(deps);
  const counts = report.capabilities.emailOutbox.counts;
  if (counts) {
    // Only the four observed numeric counts may cross the MCP boundary.
    const { queued, drafted, sent, stuck } = counts;
    if ([queued, drafted, sent, stuck].every(n => Number.isSafeInteger(n) && n >= 0)) {
      report.capabilities.emailOutbox.counts = { queued, drafted, sent, stuck };
    } else {
      delete report.capabilities.emailOutbox.counts;
    }
  }
  return report;
}
