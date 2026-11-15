/** Named surface ownership evidence for the isolated read-only fleet MCP server. */
import { readSurfaceOwner, SURFACES, type SurfaceOwnerDeps, type SurfaceOwnerReport } from '../core/fleet/surface-owner.js';
import { gitSurfaceLog } from '../core/fleet/surface-owner-git-log.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const NOTE = "Read-only sanitized surface ownership evidence. Claims are advisory only; this grants no dispatch, claim or merge authority. Reads this computer's ledger and origin/master history; landed history is not ownership. No caller root, path or cwd is accepted, and the tool never writes anything.";

/** Reject unknown surfaces and every extra key before reading any host state. */
export function parseFleetSurfaceOwnerArgs(args: Record<string, unknown>): { surface: string } | null {
  return Object.keys(args).length === 1 && Object.hasOwn(args, 'surface')
    && typeof args.surface === 'string' && Object.hasOwn(SURFACES, args.surface)
    ? { surface: args.surface } : null;
}

export const SURFACE_OWNER_READ_DEADLINE_MS = 5_000;

export async function readFleetSurfaceOwner(
  surface: string, deps: SurfaceOwnerDeps = {}, deadlineMs = SURFACE_OWNER_READ_DEADLINE_MS,
) {
  if (!Object.hasOwn(SURFACES, surface)) return null;
  const timeout = Symbol('read deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let report: SurfaceOwnerReport | null;
  try {
    // The race bounds waiting, not the host operation. Its rejection handler
    // remains attached after timeout so late failures are consumed.
    report = await Promise.race([
      Promise.resolve().then(() => readSurfaceOwner(surface, { ...deps, log: deps.log ?? gitSurfaceLog })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout), deadlineMs);
      }),
    ]);
  } catch (error) {
    let asOf: string;
    try { asOf = new Date((deps.now ?? Date.now)()).toISOString(); }
    catch { asOf = new Date().toISOString(); }
    report = {
      schemaVersion: 1, authority: 'none', surface, asOf,
      owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [], lastLanded: null,
      scannedPaths: [], reasons: [error === timeout
        ? 'surface owner: read deadline exceeded' : 'surface owner: reader failed'],
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return sanitizePublicJson(report === null ? null : { ...report, note: NOTE });
}
