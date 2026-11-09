/**
 * fleet_path_cochanges — which literal repository paths historically changed
 * alongside a proposed edit path, for the isolated fleet MCP server. A
 * planner asks this before choosing a collision-free task, using the same
 * reader as `phm fleet path-cochanges` — never a second scanner — so the MCP
 * answer and the CLI cannot drift. The ref is fixed at origin/master; there
 * is deliberately no caller ref, filesystem root, cwd or executable
 * argument.
 *
 * Every returned row is recorded merge evidence, never dependency proof or
 * edit authority. The scan is bounded (at most 100 commits touching the
 * literal path, at most 20 bridge commits inspected) and the result is
 * bounded (at most `limit` companion paths), so an empty or capped result
 * proves only what the bounded sample saw — it does not prove no other path
 * changed alongside it.
 */
import { pathCochanges, validCochangesPath } from '../core/fleet/path-cochanges.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_FLEET_PATH_COCHANGES = 100;
export const DEFAULT_FLEET_PATH_COCHANGES = 20;

export interface FleetPathCochangesArgs {
  /** Repository-relative literal pathspec such as src/mcp/fleet-server.ts. */
  path: string;
  /** Companion paths to return; the commit scan itself is always bounded. */
  limit: number;
}

type PathCochangesResult = Awaited<ReturnType<typeof pathCochanges>>;

export interface FleetPathCochangesV1 extends PathCochangesResult {
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

const PATH_COCHANGES_KEYS = new Set(['path', 'limit']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, root, cwd or executable), a missing or
 * unsafe path, and null, non-integer or out-of-range limits are rejected
 * before the git reader runs. The core validator is reused directly so the
 * MCP surface and the CLI can never disagree on what a safe path is.
 */
export function parseFleetPathCochangesArgs(args: Record<string, unknown>): FleetPathCochangesArgs | null {
  const path = args['path'], limit = args['limit'] ?? DEFAULT_FLEET_PATH_COCHANGES;
  if (Object.keys(args).some(key => !PATH_COCHANGES_KEYS.has(key)) ||
    typeof path !== 'string' || !validCochangesPath(path) ||
    args['limit'] === null ||
    typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FLEET_PATH_COCHANGES) return null;
  return { path, limit };
}

/**
 * Reuse the core's single bounded read and preserve its resolvedRef,
 * evidence, counts and every truncation flag verbatim. Reader failures (no
 * git, missing origin/master, unreadable object store) propagate — the
 * server reports them as a sanitized tool error, never fabricated evidence.
 */
export async function readFleetPathCochanges(input: FleetPathCochangesArgs, deps: { read?: typeof pathCochanges } = {}): Promise<FleetPathCochangesV1> {
  const result = await (deps.read ?? pathCochanges)(input.path, { limit: input.limit });
  return sanitizePublicJson({
    ...result,
    snapshotKind: 'local-persisted',
    authority: 'none',
    generatedAt: new Date().toISOString(),
  }) as FleetPathCochangesV1;
}
