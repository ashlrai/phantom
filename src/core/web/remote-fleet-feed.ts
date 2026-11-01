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

// These match the remote gateway's body grammar; the Hub also checks known
// switches, known lanes, and each lane's current bounds.
const FLEET_LANE_ID = /^[a-z][a-z0-9-]{1,40}$/;
const FLEET_SWITCH_ID = /^[A-Za-z][A-Za-z0-9_-]{1,40}$/;

function validateLane(lane: string): void {
  if (typeof lane !== 'string' || !FLEET_LANE_ID.test(lane)) throw new TypeError('invalid lane');
}

function rejectExtraArguments(extra: never[]): void {
  if (extra.length > 0) throw new TypeError('unsupported fleet action options');
}

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
    readLaneHolds: (...extra: never[]) => {
      rejectExtraArguments(extra);
      return transport.get<LaneTargetsV1>('/api/verse/fleet/control/holds');
    },
    setLaneTarget: (lane: string, target: number, ...extra: never[]) => {
      rejectExtraArguments(extra);
      validateLane(lane);
      if (!Number.isSafeInteger(target) || target < 0 || target > 64) throw new RangeError('invalid lane target');
      return transport.mutate<LaneTargetsV1>('POST', '/api/verse/fleet/control/lanes', { lane, target });
    },
    setSwitch: (id: string, on: boolean, ...extra: never[]) => {
      rejectExtraArguments(extra);
      if (typeof id !== 'string' || !FLEET_SWITCH_ID.test(id) || typeof on !== 'boolean') throw new TypeError('invalid switch');
      return transport.mutate<RunsSwitchesV1>('POST', '/api/verse/fleet/control/switches', { id, on });
    },
    releaseLaneHold: (lane: string, reason?: string, ...extra: never[]) => {
      rejectExtraArguments(extra);
      validateLane(lane);
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 120)) throw new TypeError('invalid hold release reason');
      return transport.mutate<LaneTargetsV1>('POST', '/api/verse/fleet/control/holds',
        reason === undefined ? { lane, action: 'release' } : { lane, action: 'release', reason });
    },
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
