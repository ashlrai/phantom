import { buildDotEvidencePacket, type DotEvidenceDeps } from '../core/comms/dot-evidence-packet.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity } from '../core/fleet/runtime-identity.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from '../core/fleet/tailnet-peers.js';
import { readSlackRequestTrace } from '../core/agents/slack-request-trace.js';
import { readFleetBoard } from '../core/fleet/coordination.js';
import { resolveDotBridgeOwner } from '../core/comms/dot-bridge-owner.js';
import { DOT_HANDOFF_SUMMARY } from './fleet-dot-handoff.js';

const usage = 'Usage: ashlr fleet dot-evidence [--json]';

/** Default readers; the bridge owner is resolved by the caller (async) and passed in. */
function defaultDeps(owner: string | null): DotEvidenceDeps {
  const t = DOT_HANDOFF_SUMMARY.transport;
  return {
    now: () => new Date(),
    readRuntime: () => readRuntimeIdentity(defaultRuntimeIdentityDeps()),
    readTailnet: () => readTailnetPeers(defaultTailnetPeersDeps()),
    readBoard: () => readFleetBoard({ reap: false }),
    readSlack: () => readSlackRequestTrace(),
    transport: { phantomToDot: t.phantomToDot, teammateTransport: t.teammateTransport, hostQualification: t.hostQualification },
    // Only a live advisory claim naming dot-handoff counts; otherwise null stays "unknown".
    bridgeOwner: () => owner,
  };
}

/** Read-only sanitized evidence packet for Dot's Slack request. Exit 0 only when nothing is missing. */
export async function cmdFleetDotEvidence(args: string[], deps?: DotEvidenceDeps): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json) json = true;
    else { console.error(usage); return 2; }
  }
  const p = buildDotEvidencePacket(deps ?? defaultDeps(await resolveDotBridgeOwner()));
  const code = p.missing.length === 0 ? 0 : 1;
  if (json) { console.log(JSON.stringify(p, null, 2)); return code; }
  const s = (v: unknown): string => JSON.stringify(v);
  console.log([
    `runtime: ${s(p.runtime)}`,
    `tailnet: ${s(p.tailnet)}`,
    `claims: ${s(p.claims)}`,
    `slack: ${s(p.slack)}`,
    `bridge: ${s(p.bridge)}`,
    `missing: ${p.missing.length === 0 ? 'none' : p.missing.join(', ')}`,
  ].join('\n'));
  return code;
}
