/**
 * fleet_kept — the `ashlr fleet kept` report projected for MCP: why worktrees
 * were kept, grouped by reason with the oldest job ids. Read-only; an
 * unreadable status or ledger is reported as an error body, never as zero
 * kept worktrees.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FLEET_KEPT_SCHEMA, parseKeptWorktrees, summarizeFleetKept,
  type FleetKeptReader, type FleetKeptReport,
} from '../cli/fleet-kept.js';

const UNREADABLE = 'Queue status or jobs ledger is unreadable.';

export interface FleetKeptErrorV1 {
  schema: typeof FLEET_KEPT_SCHEMA;
  readOnly: true;
  error: string;
}

/** Zero-argument tool: only an empty object is valid input. */
export function parseFleetKeptArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export async function readFleetKeptTool(
  deps: { readStatus?: FleetKeptReader; readJobs?: FleetKeptReader } = {},
): Promise<FleetKeptReport | FleetKeptErrorV1> {
  const readStatus = deps.readStatus ?? (path => readFile(path, 'utf8'));
  const readJobs = deps.readJobs ?? (path => readFile(path, 'utf8'));
  try {
    const kept = parseKeptWorktrees(await readStatus(join(homedir(), '.ashlr-runs', 'queue', 'status.json')));
    return summarizeFleetKept(kept, await readJobs(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')));
  } catch {
    return { schema: FLEET_KEPT_SCHEMA, readOnly: true, error: UNREADABLE };
  }
}
