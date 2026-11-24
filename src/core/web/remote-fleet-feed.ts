import type { FleetLiveSnapshotV1 } from '../fleet/fleet-types.js';
import type { FleetBusFeedV1 } from '../fleet/bus-feed.js';
import type { LaneTargetsV1 } from '../fleet/runs-lane-targets.js';
import type { FleetQueueV1 } from '../fleet/runs-parked-queue.js';
import type { RunsSwitchesV1 } from '../fleet/runs-switches.js';
import type { FleetInboxReadV1 } from '../verse/fleet-inbox-read.js';
import type { FleetRunsV1 } from '../verse/fleet-runs-types.js';
import type { FleetJobDetailV1 } from '../fleet/runs-job-detail.js';

/** Supply the phone's authenticated gateway transport (remoteApiGet/remoteMutate).
 * Mutations must complete the gateway's CSRF and WebAuthn step-up flow. No
 * local Hub credentials or device IDs belong in this adapter.
 */
export interface RemoteFleetTransport {
  get<T>(path: string): Promise<T>;
  mutate<T>(method: 'POST', path: string, body: unknown): Promise<T>;
}

export interface RemoteFleetReadOptions { limit?: number }
export interface RemoteFleetInboxOptions extends RemoteFleetReadOptions {
  source?: string;
  contains?: string;
  priority?: string;
  after?: string;
  before?: string;
}

// These match the remote gateway's body grammar; the Hub also checks known
// switches, known lanes, and each lane's current bounds.
const FLEET_LANE_ID = /^[a-z][a-z0-9-]{1,40}$/;
const FLEET_SWITCH_ID = /^[A-Za-z][A-Za-z0-9_-]{1,40}$/;
// The inbox read filters mirror the gateway's grammar; the Hub re-validates.
const INBOX_PRIORITY = /^P[0-3]$/;
const INBOX_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const INBOX_CONTAINS_MAX = 512;
const INBOX_FILTER_KEYS = new Set(['source', 'contains', 'priority', 'after', 'before']);

function validateLane(lane: string): void {
  if (typeof lane !== 'string' || !FLEET_LANE_ID.test(lane)) throw new TypeError('invalid lane');
}

function rejectExtraArguments(extra: never[]): void {
  if (extra.length > 0) throw new TypeError('unsupported fleet action options');
}

function validateOptions(options: RemoteFleetInboxOptions, inboxFilters: boolean): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => key !== 'limit' && !(inboxFilters && INBOX_FILTER_KEYS.has(key)))) {
    throw new TypeError('invalid fleet read options');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
    throw new RangeError('limit must be an integer from 1 to 200');
  }
  if (options.source !== undefined && (typeof options.source !== 'string' || !/^[A-Za-z0-9 ._-]{1,40}$/.test(options.source))) {
    throw new TypeError('invalid inbox source');
  }
  if (options.contains !== undefined && (typeof options.contains !== 'string' || options.contains.trim() === '' || options.contains.length > INBOX_CONTAINS_MAX)) {
    throw new TypeError('invalid inbox contains');
  }
  if (options.priority !== undefined && (typeof options.priority !== 'string' || !INBOX_PRIORITY.test(options.priority))) {
    throw new TypeError('invalid inbox priority');
  }
  for (const key of ['after', 'before'] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'string' || !INBOX_INSTANT.test(value))) throw new TypeError(`invalid inbox ${key}`);
  }
}

function limitedPath(path: string, options: RemoteFleetReadOptions): string {
  validateOptions(options, false);
  return options.limit === undefined ? path : `${path}?limit=${options.limit}`;
}

function inboxPath(options: RemoteFleetInboxOptions): string {
  validateOptions(options, true);
  const parts = [`limit=${options.limit ?? 50}`];
  for (const key of ['source', 'contains', 'priority', 'after', 'before'] as const) {
    const value = options[key];
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return `/api/verse/fleet/runs/inbox?${parts.join('&')}`;
}

// Same grammar the Hub applies in runs-job-detail `isFleetJobId` and the
// gateway applies in remote-gateway-policy FLEET_JOB_ID; duplicated so this
// module stays free of server-side imports. The explicit CRLF check is load
// bearing: `$` matches before a trailing line terminator, so JOB_ID alone
// would accept a newline-suffixed id the Hub rejects.
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

function validJobId(id: unknown): id is string {
  return typeof id === 'string' && !/[\r\n]+$/.test(id) && JOB_ID.test(id);
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
    inbox: (options: RemoteFleetInboxOptions = {}) =>
      transport.get<FleetInboxReadV1 | null>(inboxPath(options)),
    job: (id: string) => {
      if (!validJobId(id)) throw new TypeError('invalid fleet job id');
      return transport.get<FleetJobDetailV1>(`/api/fleet/job?id=${encodeURIComponent(id)}`);
    },
    queue: (options: RemoteFleetReadOptions = {}) => transport.get<FleetQueueV1>(limitedPath('/api/verse/fleet/live/queue', options)),
    bus: (options: RemoteFleetReadOptions = {}) => transport.get<FleetBusFeedV1>(limitedPath('/api/verse/fleet/live/bus', options)),
    pause: () => transport.mutate('POST', '/api/verse/daemon', { action: 'pause' }),
    resume: () => transport.mutate('POST', '/api/verse/daemon', { action: 'resume' }),
    kill: () => transport.mutate('POST', '/api/verse/authority', { action: 'stop' }),
  };
}
