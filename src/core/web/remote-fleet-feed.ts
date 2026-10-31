import type { FleetLiveSnapshotV1 } from '../fleet/fleet-types.js';
import type { FleetBusFeedV1 } from '../fleet/bus-feed.js';
import type { LaneTargetsV1 } from '../fleet/runs-lane-targets.js';
import type { FleetQueueV1 } from '../fleet/runs-parked-queue.js';
import type { RunsSwitchesV1 } from '../fleet/runs-switches.js';
import type { FleetInboxReadV1 } from '../verse/fleet-inbox-read.js';
import type { FleetRunsV1 } from '../verse/fleet-runs-types.js';

/** Supply the phone's authenticated gateway transport (remoteApiGet/remoteMutate).
 * Mutations must complete the gateway's CSRF and WebAuthn step-up flow. No
 * local Hub credentials or device IDs belong in this adapter.
 */
export interface RemoteFleetTransport {
  get<T>(path: string): Promise<T>;
  mutate<T>(method: 'POST', path: string, body: unknown): Promise<T>;
}

export interface RemoteFleetReadOptions { limit?: number }
export interface RemoteFleetInboxOptions extends RemoteFleetReadOptions { source?: string }

function validateOptions(options: RemoteFleetInboxOptions, allowSource: boolean): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => key !== 'limit' && !(allowSource && key === 'source'))) {
    throw new TypeError('invalid fleet read options');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
    throw new RangeError('limit must be an integer from 1 to 200');
  }
  if (options.source !== undefined && (typeof options.source !== 'string' || !/^[A-Za-z0-9 ._-]{1,40}$/.test(options.source))) {
    throw new TypeError('invalid inbox source');
  }
}

function limitedPath(path: string, options: RemoteFleetReadOptions): string {
  validateOptions(options, false);
  return options.limit === undefined ? path : `${path}?limit=${options.limit}`;
}

/** Mobile fleet snapshot, including active jobs, using only reviewed routes.
 * Pause/resume control autonomous dispatch; kill engages the global Stop.
 * Resume does not clear Stop or grant new authority.
 */
export function createRemoteFleetFeed(transport: RemoteFleetTransport) {
  return {
    list: () => transport.get<FleetLiveSnapshotV1>('/api/verse/fleet/live'),
    runs: () => transport.get<FleetRunsV1>('/api/verse/fleet/runs'),
    laneTargets: () => transport.get<LaneTargetsV1>('/api/verse/fleet/control/lanes'),
    switches: () => transport.get<RunsSwitchesV1>('/api/verse/fleet/control/switches'),
    inbox: (options: RemoteFleetInboxOptions = {}) => {
      validateOptions(options, true);
      const source = options.source === undefined ? '' : `&source=${encodeURIComponent(options.source)}`;
      return transport.get<FleetInboxReadV1 | null>(`/api/verse/fleet/runs/inbox?limit=${options.limit ?? 50}${source}`);
    },
    queue: (options: RemoteFleetReadOptions = {}) => transport.get<FleetQueueV1>(limitedPath('/api/verse/fleet/live/queue', options)),
    bus: (options: RemoteFleetReadOptions = {}) => transport.get<FleetBusFeedV1>(limitedPath('/api/verse/fleet/live/bus', options)),
    pause: () => transport.mutate('POST', '/api/verse/daemon', { action: 'pause' }),
    resume: () => transport.mutate('POST', '/api/verse/daemon', { action: 'resume' }),
    kill: () => transport.mutate('POST', '/api/verse/authority', { action: 'stop' }),
  };
}
