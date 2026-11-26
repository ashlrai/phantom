/**
 * fleet_trim — the `ashlr fleet trim` report projected for MCP: lanes that are
 * starved or waste slots, with SLOTS suggestions. Advisory and read-only:
 * nothing is applied, and an unreadable or invalid status is reported as an
 * error body, never as a clean fleet.
 */
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readQueueStatusView } from '../core/fleet/queue-status-read.js';
import { FLEET_TRIM_SCHEMA, trimFleet, type FleetTrimReader, type FleetTrimReport } from '../cli/fleet-trim.js';

export interface FleetTrimErrorV1 {
  schema: typeof FLEET_TRIM_SCHEMA;
  readOnly: true;
  error: string;
}

/** Zero-argument tool: only an empty object is valid input. */
export function parseFleetTrimArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export async function readFleetTrimTool(
  deps: { readStatus?: FleetTrimReader } = {},
): Promise<FleetTrimReport | FleetTrimErrorV1> {
  const result = await readQueueStatusView(
    value => sanitizePublicJson(trimFleet(value)) as FleetTrimReport,
    { read: deps.readStatus, subject: 'fleet_trim' },
  );
  if (!result.ok) return { schema: FLEET_TRIM_SCHEMA, readOnly: true, error: result.message };
  return result.view;
}
