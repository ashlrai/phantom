/**
 * fleet_main_health — the main-guardian status table
 * (`<runs>/supervisor/status-main-guardian.md`) projected for MCP: per repo
 * the default branch, sha, state, failing check, open fix job ids and
 * nightly red, plus the stale, guardianOff and red-count verdicts. A
 * persisted observation only: unknown or stale evidence is not green, and
 * no field here authorizes a merge, a recut or a fix job.
 */
import { readFleetMainHealth, type FleetMainHealthV1 } from '../core/fleet/main-health.js';

/** Zero-argument tool: only an empty object is valid input. */
export function parseFleetMainHealthArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export async function readFleetMainHealthTool(): Promise<FleetMainHealthV1> {
  return readFleetMainHealth();
}
