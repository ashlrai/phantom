import { buildDotEvidencePacket, type DotEvidenceDeps } from '../core/comms/dot-evidence-packet.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity } from '../core/fleet/runtime-identity.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from '../core/fleet/tailnet-peers.js';
import { readSlackRequestTrace } from '../core/agents/slack-request-trace.js';
import { readFleetBoard } from '../core/fleet/coordination.js';
import { DOT_HANDOFF_SUMMARY } from './fleet-dot-handoff.js';

const usage = 'Usage: ashlr fleet dot-evidence [--json]';

function defaultDeps(): DotEvidenceDeps {
  const t = DOT_HANDOFF_SUMMARY.transport;
  return {
    now: () => new Date(),
    readRuntime: () => readRuntimeIdentity(defaultRuntimeIdentityDeps()),
    readTailnet: () => readTailnetPeers(defaultTailnetPeersDeps()),
    readBoard: () => readFleetBoard({ reap: false }),
    readSlack: () => readSlackRequestTrace(),
    transport: { phantomToDot: t.phantomToDot, teammateTransport: t.teammateTransport, hostQualification: t.hostQualification },
    // No repo source names a Dot bridge owner yet; stays unknown rather than guessed.
    bridgeOwner: () => null,
  };
}

/** Read-only sanitized evidence packet for Dot's Slack request. Exit 0 only when nothing is missing. */
export async function cmdFleetDotEvidence(args: string[], deps: DotEvidenceDeps = defaultDeps()): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json) json = true;
    else { console.error(usage); return 2; }
  }
  const p = buildDotEvidencePacket(deps);
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
