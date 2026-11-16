/** Read-only joined runtime evidence under the existing identity prefix. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps, type RuntimeSnapshot } from '../fleet/runtime-snapshot.js';

export const VERSE_FLEET_RUNTIME_SNAPSHOT_PATH = '/api/verse/fleet/runtime-identity/snapshot';

// The reader's numeric process fields become UNKNOWN when the whole read fails.
type UnknownRuntimeSnapshot = Omit<RuntimeSnapshot, 'pid' | 'uptimeSeconds'> & {
  pid: 'UNKNOWN';
  uptimeSeconds: 'UNKNOWN';
};

export interface FleetRuntimeSnapshotResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  snapshot: RuntimeSnapshot | UnknownRuntimeSnapshot;
}

function unknownSnapshot(): UnknownRuntimeSnapshot {
  return {
    host: 'UNKNOWN', tailnetName: 'UNKNOWN', installedVersion: 'UNKNOWN', sourceVersion: 'UNKNOWN',
    pid: 'UNKNOWN', uptimeSeconds: 'UNKNOWN', platform: 'UNKNOWN', arch: 'UNKNOWN', stateRoot: 'UNKNOWN',
    lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
    coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN' },
    asOf: 'UNKNOWN', reasons: ['runtime snapshot: reader failed; all fields unknown'],
  };
}

export function createFleetRuntimeSnapshotApi(deps: {
  runtimeDeps?: FleetRuntimeDeps;
  now?: () => Date;
} = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_RUNTIME_SNAPSHOT_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    let snapshot: FleetRuntimeSnapshotResponse['snapshot'];
    try {
      snapshot = await readRuntimeSnapshot(deps.runtimeDeps ?? defaults);
    } catch {
      snapshot = unknownSnapshot();
    }
    const response: FleetRuntimeSnapshotResponse = { v: 1, authority: 'none', generatedAt, snapshot };
    sendJson(res, 200, response);
    return true;
  };
}

export const handleFleetRuntimeSnapshotApi: ApiModule = createFleetRuntimeSnapshotApi();
