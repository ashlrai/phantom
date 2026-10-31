import type { FleetLiveSnapshotV1 } from '../fleet/fleet-types.js';

/** Supply the phone's authenticated gateway transport (remoteApiGet/remoteMutate).
 * Mutations must complete the gateway's CSRF and WebAuthn step-up flow. No
 * local Hub credentials or device IDs belong in this adapter.
 */
export interface RemoteFleetTransport {
  get<T>(path: string): Promise<T>;
  mutate<T>(method: 'POST', path: string, body: unknown): Promise<T>;
}

/** Mobile fleet snapshot, including active jobs, using only reviewed routes.
 * Pause/resume control autonomous dispatch; kill engages the global Stop.
 * Resume does not clear Stop or grant new authority.
 */
export function createRemoteFleetFeed(transport: RemoteFleetTransport) {
  return {
    list: () => transport.get<FleetLiveSnapshotV1>('/api/verse/fleet/live'),
    pause: () => transport.mutate('POST', '/api/verse/daemon', { action: 'pause' }),
    resume: () => transport.mutate('POST', '/api/verse/daemon', { action: 'resume' }),
    kill: () => transport.mutate('POST', '/api/verse/authority', { action: 'stop' }),
  };
}
