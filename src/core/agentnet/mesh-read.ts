/** Shared metadata reads require a live peer session, never a role, lease or send grant. */
import { readAgentMesh } from '../agents/mesh.js';
import { readBusWorkFeed } from '../agents/bus-work-feed-read.js';
import { agentnetPaths, authenticatePeer, readPeerBindings, type PeerSession } from './slack-identities.js';
import type { PeerBusOptions } from './peer-bus.js';

export function readPeerFleet(view: 'mesh' | 'work-feed', session: PeerSession, options: PeerBusOptions = {}) {
  const now = (options.now ?? Date.now)(), paths = { ...agentnetPaths(), ...options };
  authenticatePeer(readPeerBindings(paths.bindings), session, now);
  const read = { root: paths.busRoot, now: () => now };
  return view === 'mesh' ? readAgentMesh(read) : readBusWorkFeed(read);
}
