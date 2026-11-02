/** Best-effort notification of releases on the shared fleet bus. */
import { appendBusInbox, type BusInboxPost } from './bus-inbox.js';
import type { BusEnvelope } from './bus-envelope.js';
import { fleetBusEventId } from './bus-mirror-dispatch.js';
import { CHANNEL_BUS_TTL_MS } from './channel-bus-publish.js';
import type { ResetReleaseRecord } from './usage-reset-release.js';

export const RESET_RELEASE_BUS_KIND = 'lane-released';

export function buildResetReleaseEnvelope(record: ResetReleaseRecord): BusEnvelope {
  return {
    id: fleetBusEventId(RESET_RELEASE_BUS_KIND, record.at, record.lane),
    from: 'fleet', to: 'all', priority: 'P2', ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: RESET_RELEASE_BUS_KIND, lane: record.lane, at: record.at,
      by: record.by, reason: record.reason, usedPct: record.usedPct,
      readingAsOf: record.readingAsOf, heldUntil: record.heldUntil,
      text: `${record.lane} released: ${record.reason}`.slice(0, 200),
    },
  };
}

export type ResetReleaseBusPost = { lane: string; status: BusInboxPost['status'] };

export function postResetReleaseNotice(
  record: ResetReleaseRecord,
  post: typeof appendBusInbox = appendBusInbox,
  options?: { root?: string; now?: () => number },
): ResetReleaseBusPost {
  try {
    return { lane: record.lane, status: post(buildResetReleaseEnvelope(record), options).status };
  } catch {
    return { lane: record.lane, status: 'unavailable' };
  }
}
