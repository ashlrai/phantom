import { defaultTailnetPeersDeps, readTailnetPeers, type TailnetPeersDeps } from '../core/fleet/tailnet-peers.js';

const usage = 'Usage: ashlr fleet tailnet-peers [--json]';

/** Print sanitized, read-only evidence of which tailnet peers are visible now. */
export async function cmdFleetTailnetPeers(args: string[], deps: TailnetPeersDeps = defaultTailnetPeersDeps()): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else { console.error(usage); return 2; }
  }
  const status = readTailnetPeers(deps);
  if (json) { console.log(JSON.stringify(status, null, 2)); return 0; }
  const lines = [
    `self ${status.self} as of ${status.asOf}`,
    ...status.peers.map(peer => {
      const state = peer.online === true ? 'online' : peer.online === false ? 'offline' : 'unknown';
      const age = typeof peer.ageSeconds === 'number' ? `${peer.ageSeconds}s ago` : 'unknown';
      return `${state} ${peer.name} ${peer.os} last seen ${age}`;
    }),
    ...status.reasons.map(reason => `reason: ${reason}`),
  ];
  console.log(lines.join('\n'));
  return 0;
}
