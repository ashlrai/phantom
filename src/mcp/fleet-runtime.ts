/** Joined runtime and coordination evidence for the isolated fleet MCP server. */
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps } from '../core/fleet/runtime-snapshot.js';

const NOTE = 'Read-only sanitized runtime and coordination evidence with one asOf, the same snapshot as `ashlr fleet runtime`. Evidence only; it grants no dispatch, claim or merge authority. An MCP server on another computer reads that computer\'s state. Takes no arguments; no caller root, path or cwd is accepted, and the tool never writes anything.';

/** Reject every caller key before reading any host state. */
export function parseFleetRuntimeArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export async function readFleetRuntime(deps: FleetRuntimeDeps = defaults) {
  return { schemaVersion: 1 as const, authority: 'none' as const, note: NOTE, ...await readRuntimeSnapshot(deps) };
}
