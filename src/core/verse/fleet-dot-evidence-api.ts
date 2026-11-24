/** Desktop surface for Dot's evidence packet: the same sanitized, read-only
 * packet `ashlr fleet dot-evidence` prints, with the bridge owner taken from a
 * live claim naming dot-handoff. GET only; a failed build degrades to an
 * all-unavailable packet with fixed reasons and never echoes the error. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import {
  buildDotEvidencePacket, DOT_EVIDENCE_SCHEMA, type DotEvidenceDeps, type DotEvidencePacket,
} from '../comms/dot-evidence-packet.js';
import { resolveDotBridgeOwner } from '../comms/dot-bridge-owner.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity } from '../fleet/runtime-identity.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from '../fleet/tailnet-peers.js';
import { readSlackRequestTrace } from '../agents/slack-request-trace.js';
import { readFleetBoard } from '../fleet/coordination.js';

export const VERSE_FLEET_DOT_EVIDENCE_PATH = '/api/verse/fleet/runtime-identity/dot-evidence';

export interface FleetDotEvidenceResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  packet: DotEvidencePacket;
}

export interface FleetDotEvidenceApiDeps {
  /** Packet deps seam for tests. Default: the CLI's readers plus the resolved owner. */
  packetDeps?: (owner: string | null) => DotEvidenceDeps;
  /** Owner resolver seam for tests. Default: resolveDotBridgeOwner. */
  resolveOwner?: () => Promise<string | null>;
  now?: () => Date;
}

/** Copy of DOT_HANDOFF_SUMMARY.transport (src/cli/fleet-dot-handoff.ts); core does not import the CLI here.
 * test/fleet-dot-evidence-api-709.test.ts asserts these stay equal. */
export const DOT_EVIDENCE_TRANSPORT: DotEvidenceDeps['transport'] = {
  phantomToDot: 'unverified', teammateTransport: 'available-in-source', hostQualification: 'not-observed',
};

/** Same readers as `ashlr fleet dot-evidence`, with the owner resolved by the caller. */
export function defaultDotEvidenceDeps(owner: string | null): DotEvidenceDeps {
  return {
    now: () => new Date(),
    readRuntime: () => readRuntimeIdentity(defaultRuntimeIdentityDeps()),
    readTailnet: () => readTailnetPeers(defaultTailnetPeersDeps()),
    readBoard: () => readFleetBoard({ reap: false }),
    readSlack: () => readSlackRequestTrace(),
    transport: DOT_EVIDENCE_TRANSPORT,
    bridgeOwner: () => owner,
  };
}

function unavailablePacket(asOf: string): DotEvidencePacket {
  return {
    schema: DOT_EVIDENCE_SCHEMA, asOf,
    runtime: { state: 'unavailable' }, tailnet: { state: 'unavailable' },
    claims: { state: 'unavailable' }, slack: { state: 'unavailable' },
    bridge: { owner: 'unknown', transport: DOT_EVIDENCE_TRANSPORT },
    missing: ['dot-evidence-unavailable'],
  };
}

export function createFleetDotEvidenceApi(deps: FleetDotEvidenceApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const packetDeps = deps.packetDeps ?? defaultDotEvidenceDeps;
  const resolveOwner = deps.resolveOwner ?? resolveDotBridgeOwner;
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_DOT_EVIDENCE_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    let packet: DotEvidencePacket;
    try {
      packet = buildDotEvidencePacket(packetDeps(await resolveOwner()));
    } catch {
      packet = unavailablePacket(generatedAt);
    }
    const body: FleetDotEvidenceResponse = { v: 1, authority: 'none', generatedAt, packet };
    sendJson(res, 200, body);
    return true;
  };
}

export const handleFleetDotEvidenceApi: ApiModule = createFleetDotEvidenceApi();
