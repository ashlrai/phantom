/**
 * fleet_trim — the `ashlr fleet trim` report projected for MCP: lanes that are
 * starved or waste slots, with SLOTS suggestions. Advisory and read-only:
 * nothing is applied, and an unreadable or invalid status is reported as an
 * error body, never as a clean fleet.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { FLEET_TRIM_SCHEMA, trimFleet, type FleetTrimReader, type FleetTrimReport } from '../cli/fleet-trim.js';

const UNREADABLE = 'Queue status is unreadable or invalid.';

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
  try {
    const text = await (deps.readStatus ?? (path => readFile(path, 'utf8')))(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
    return sanitizePublicJson(trimFleet(JSON.parse(text))) as FleetTrimReport;
  } catch {
    return { schema: FLEET_TRIM_SCHEMA, readOnly: true, error: UNREADABLE };
  }
}
