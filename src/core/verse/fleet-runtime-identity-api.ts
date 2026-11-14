/** Desktop surface for the Fleet Host pane's RuntimeIdentityCard: sanitized,
 * read-only evidence of which host and build is answering and how fresh its
 * fleet-state read is. Never writes; never returns env values, an absolute
 * home path or an IP address (readRuntimeIdentity redacts them). */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import {
  UNKNOWN,
  defaultRuntimeIdentityDeps,
  readRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeIdentityDeps,
} from '../fleet/runtime-identity.js';

export const VERSE_FLEET_RUNTIME_IDENTITY_PATH = '/api/verse/fleet/runtime-identity';

export interface FleetRuntimeIdentityApiDeps {
  /** Reader seams for tests. Default: defaultRuntimeIdentityDeps(). */
  identityDeps?: RuntimeIdentityDeps;
  /** Clock seam for tests; stamps generatedAt. */
  now?: () => Date;
}

/** Every field "unknown" plus a reason; never carries the thrown message. */
function unknownIdentity(asOf: string): RuntimeIdentity {
  return {
    host: UNKNOWN, platform: UNKNOWN, asOf,
    installedVersion: UNKNOWN, sourceVersion: UNKNOWN, versionDrift: false,
    fleetState: { path: UNKNOWN, mtime: UNKNOWN, ageSeconds: UNKNOWN, stale: UNKNOWN },
    tailnetName: UNKNOWN,
    reasons: ['runtime identity: reader failed; all fields unknown'],
  };
}

export function createFleetRuntimeIdentityApi(deps: FleetRuntimeIdentityApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_RUNTIME_IDENTITY_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    let identity: RuntimeIdentity;
    try {
      identity = readRuntimeIdentity(deps.identityDeps ?? defaultRuntimeIdentityDeps());
    } catch {
      identity = unknownIdentity(generatedAt);
    }
    sendJson(res, 200, { v: 1, generatedAt, identity });
    return true;
  };
}

export const handleFleetRuntimeIdentityApi: ApiModule = createFleetRuntimeIdentityApi();
