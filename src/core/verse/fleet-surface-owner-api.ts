/** Read-only surface ownership evidence under the existing identity prefix:
 * which advisory claim owns a named slice of the tree right now, plus the
 * landed history behind it. Never writes; a thrown reader degrades to UNKNOWN
 * evidence with a fixed reason and never leaks the error text. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readSurfaceOwner, SURFACES, type SurfaceOwnerReport } from '../fleet/surface-owner.js';
import { gitSurfaceLog } from '../fleet/surface-owner-git-log.js';

export const FLEET_SURFACE_OWNER_READ_DEADLINE_MS = 5_000;

export const VERSE_FLEET_SURFACE_OWNER_PATH = '/api/verse/fleet/runtime-identity/surface-owner';

/** The closed surface enum the route advertises, sorted for stable output. */
const SURFACE_NAMES = [...Object.keys(SURFACES)].sort();

export interface FleetSurfaceOwnerReportResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: SurfaceOwnerReport;
}

export interface FleetSurfaceOwnerListResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  surfaces: SurfaceOwnerReport[];
}

export interface FleetSurfaceOwnerApiDeps {
  /** Reader seam for tests. Default: readSurfaceOwner with the shared git history reader. */
  read?: (surface: string) => Promise<SurfaceOwnerReport | null>;
  /** Clock seam for tests; stamps generatedAt and a degraded report's asOf. */
  now?: () => Date;
  /** Whole-request read budget seam for tests. */
  deadlineMs?: number;
}

/** Every field empty/UNKNOWN plus a fixed reason; never carries the thrown message. */
function unknownReport(surface: string, asOf: string, reason = 'surface owner: reader failed'): SurfaceOwnerReport {
  return {
    surface, owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [], lastLanded: null,
    scannedPaths: [], reasons: [reason],
    schemaVersion: 1, authority: 'none', asOf,
  };
}

export function createFleetSurfaceOwnerApi(deps: FleetSurfaceOwnerApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const read = deps.read ?? ((surface: string) => readSurfaceOwner(surface, { log: gitSurfaceLog }));
  const readReports = async (surfaces: string[], generatedAt: string): Promise<SurfaceOwnerReport[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, deps.deadlineMs ?? FLEET_SURFACE_OWNER_READ_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      return await Promise.all(surfaces.map(surface => Promise.race([
        // Rejection handlers remain attached after timeout; late reads never write responses.
        Promise.resolve().then(() => read(surface)).then(
          report => report ?? unknownReport(surface, generatedAt),
          () => unknownReport(surface, generatedAt),
        ),
        deadline.then(() => unknownReport(surface, generatedAt, 'surface owner: read deadline exceeded')),
      ])));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_SURFACE_OWNER_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    // The router already stripped the query from `path`; read it from req.url.
    const params = new URL(req.url ?? '', 'http://local').searchParams;
    const keys = [...params.keys()];
    // Validate the query before any host read: zero keys lists every surface;
    // exactly one `surface` key names it; anything else is a 400.
    if (keys.length === 0) {
      const surfaces = await readReports(SURFACE_NAMES.slice(0, 12), generatedAt);
      const response: FleetSurfaceOwnerListResponse = { v: 1, authority: 'none', generatedAt, surfaces };
      sendJson(res, 200, response);
      return true;
    }
    const surface = keys.length === 1 && keys[0] === 'surface' ? params.get('surface') : null;
    if (surface === null || !Object.hasOwn(SURFACES, surface)) {
      sendJson(res, 400, { v: 1, authority: 'none', error: 'unknown surface', surfaces: SURFACE_NAMES });
      return true;
    }
    const [report] = await readReports([surface], generatedAt);
    const response: FleetSurfaceOwnerReportResponse = {
      v: 1, authority: 'none', generatedAt, report: report!,
    };
    sendJson(res, 200, response);
    return true;
  };
}

export const handleFleetSurfaceOwnerApi: ApiModule = createFleetSurfaceOwnerApi();
