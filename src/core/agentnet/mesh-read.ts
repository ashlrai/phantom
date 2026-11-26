/** Shared metadata reads require a live peer session, never a role, lease or send grant. */
import { readAgentMesh } from '../agents/mesh.js';
import { projectBusWorkFeedView, readBusWorkFeed, sliceBusWorkFeedView,
  type BusWorkFeedViewFilters } from '../agents/bus-work-feed-read.js';
import { agentnetPaths, authenticatePeer, readPeerBindings, type PeerSession } from './slack-identities.js';
import type { PeerBusOptions } from './peer-bus.js';

/**
 * The parsed work-feed query a `peers work-feed` read applies — the
 * `parseBusWorkFeedQuery` ok-branch every other feed surface serves: the
 * `claims` join flag, the `projectBusWorkFeedView` filter set and the
 * `sliceBusWorkFeedView` page bound, so a remote peer's filtered read can
 * never disagree with `phm fleet work-feed`, `phm agents bus work feed`,
 * GET `/api/verse/agent-bus/work-feed` or `fleet_work_feed` about what a
 * value means. The mesh view takes no query — passing one is a contract
 * violation, never a silently ignored filter.
 */
export interface PeerWorkFeedQuery {
  claims: boolean;
  filters: BusWorkFeedViewFilters;
  limit?: number;
}

export function readPeerFleet(view: 'mesh' | 'work-feed', session: PeerSession, options: PeerBusOptions = {},
  feed?: PeerWorkFeedQuery) {
  const now = (options.now ?? Date.now)(), paths = { ...agentnetPaths(), ...options };
  authenticatePeer(readPeerBindings(paths.bindings), session, now);
  const read = { root: paths.busRoot, now: () => now };
  if (view === 'mesh') {
    if (feed !== undefined) throw new Error('work-feed filters apply to the work-feed view only');
    return readAgentMesh(read);
  }
  const result = projectBusWorkFeedView(
    readBusWorkFeed({ ...read, ...(feed?.claims === true ? { claims: true } : {}) }),
    feed?.filters);
  return feed?.limit === undefined ? result : sliceBusWorkFeedView(result, feed.limit);
}
