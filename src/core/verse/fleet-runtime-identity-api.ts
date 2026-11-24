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
import { nodeReachView, readNodeReachSources, type NodeReachRow } from '../fleet/node-reach-view.js';
import { handleFleetBridgeCheckApi, VERSE_FLEET_BRIDGE_CHECK_PATH } from './fleet-bridge-check-api.js';
import { handleFleetClaimDriftApi, VERSE_FLEET_CLAIM_DRIFT_PATH } from './fleet-claim-drift-api.js';
import { handleFleetClaimExecutionApi, VERSE_FLEET_CLAIM_EXECUTION_PATH } from './fleet-claim-execution-api.js';
import { handleFleetDotEvidenceApi, VERSE_FLEET_DOT_EVIDENCE_PATH } from './fleet-dot-evidence-api.js';
import { handleFleetHostReachApi } from './fleet-host-reach-api.js';
import { handleFleetRuntimeSnapshotApi, VERSE_FLEET_RUNTIME_SNAPSHOT_PATH } from './fleet-runtime-snapshot-api.js';
import { handleFleetSurfaceOwnerApi, VERSE_FLEET_SURFACE_OWNER_PATH } from './fleet-surface-owner-api.js';

export const VERSE_FLEET_RUNTIME_IDENTITY_PATH = '/api/verse/fleet/runtime-identity';

export interface FleetRuntimeIdentityApiDeps {
  /** Reader seams for tests. Default: defaultRuntimeIdentityDeps(). */
  identityDeps?: RuntimeIdentityDeps;
  /** Clock seam for tests; stamps generatedAt. */
  now?: () => Date;
  /** Sub-path handler seam for tests. Default: the host-reach module. */
  hostReach?: ApiModule;
  /** Joined snapshot sub-path handler seam for tests. */
  snapshot?: ApiModule;
  /** Surface-owner sub-path handler seam for tests. */
  surfaceOwner?: ApiModule;
  /** Claim-execution sub-path handler seam for tests. */
  claimExecution?: ApiModule;
  /** Bridge-check sub-path handler seam for tests. */
  bridgeCheck?: ApiModule;
  /** Claim-drift sub-path handler seam for tests. */
  claimDrift?: ApiModule;
  /** Dot evidence packet sub-path handler seam for tests. */
  dotEvidence?: ApiModule;
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
  const hostReach = deps.hostReach ?? handleFleetHostReachApi;
  const snapshot = deps.snapshot ?? handleFleetRuntimeSnapshotApi;
  const surfaceOwner = deps.surfaceOwner ?? handleFleetSurfaceOwnerApi;
  const claimExecution = deps.claimExecution ?? handleFleetClaimExecutionApi;
  const bridgeCheck = deps.bridgeCheck ?? handleFleetBridgeCheckApi;
  const claimDrift = deps.claimDrift ?? handleFleetClaimDriftApi;
  const dotEvidence = deps.dotEvidence ?? handleFleetDotEvidenceApi;
  return async (ctx, req, res, path, method) => {
    if (path === VERSE_FLEET_RUNTIME_SNAPSHOT_PATH) return snapshot(ctx, req, res, path, method);
    if (path === VERSE_FLEET_SURFACE_OWNER_PATH) return surfaceOwner(ctx, req, res, path, method);
    if (path === VERSE_FLEET_CLAIM_EXECUTION_PATH) return claimExecution(ctx, req, res, path, method);
    if (path === VERSE_FLEET_BRIDGE_CHECK_PATH) return bridgeCheck(ctx, req, res, path, method);
    if (path === VERSE_FLEET_CLAIM_DRIFT_PATH) return claimDrift(ctx, req, res, path, method);
    if (path === VERSE_FLEET_DOT_EVIDENCE_PATH) return dotEvidence(ctx, req, res, path, method);
    // Sub-paths (tailnet-peers, pool-reach) ride this family's existing prefix.
    if (path.startsWith(`${VERSE_FLEET_RUNTIME_IDENTITY_PATH}/`)) return hostReach(ctx, req, res, path, method);
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
    let nodes: NodeReachRow[] = [];
    try { nodes = nodeReachView(readNodeReachSources(), now().getTime()); } catch { /* nodes stay empty: unknown, not offline */ }
    sendJson(res, 200, { v: 1, generatedAt, identity, nodes });
    return true;
  };
}

export const handleFleetRuntimeIdentityApi: ApiModule = createFleetRuntimeIdentityApi();
