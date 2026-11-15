/** Named surface ownership evidence for the isolated read-only fleet MCP server. */
import { readSurfaceOwner, SURFACES, type SurfaceOwnerDeps } from '../core/fleet/surface-owner.js';
import { gitSurfaceLog } from '../core/fleet/surface-owner-git-log.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const NOTE = "Read-only sanitized surface ownership evidence. Claims are advisory only; this grants no dispatch, claim or merge authority. Reads this computer's ledger and origin/master history; landed history is not ownership. No caller root, path or cwd is accepted, and the tool never writes anything.";

/** Reject unknown surfaces and every extra key before reading any host state. */
export function parseFleetSurfaceOwnerArgs(args: Record<string, unknown>): { surface: string } | null {
  return Object.keys(args).length === 1 && Object.hasOwn(args, 'surface')
    && typeof args.surface === 'string' && Object.hasOwn(SURFACES, args.surface)
    ? { surface: args.surface } : null;
}

export async function readFleetSurfaceOwner(surface: string, deps: SurfaceOwnerDeps = {}) {
  const report = await readSurfaceOwner(surface, { ...deps, log: deps.log ?? gitSurfaceLog });
  return sanitizePublicJson(report === null ? null : { ...report, note: NOTE });
}
