/** Read-only joined runtime evidence under the existing identity prefix. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { PROCESS_SNAPSHOT_MAX_AGE_MS } from '../fleet/claim-execution-evidence.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps, type RuntimeSnapshot } from '../fleet/runtime-snapshot.js';

export const VERSE_FLEET_RUNTIME_SNAPSHOT_PATH = '/api/verse/fleet/runtime-identity/snapshot';

// A stalled filesystem scan must still produce a bounded UNKNOWN answer; the
// race does not cancel the underlying read, it only stops waiting for it.
export const FLEET_RUNTIME_SNAPSHOT_READ_DEADLINE_MS = 5_000;
const READER_FAILED_REASON = 'runtime snapshot: reader failed; all fields unknown';
const READ_DEADLINE_REASON = 'runtime snapshot: read deadline exceeded; all fields unknown';
const STALE_SNAPSHOT_REASON = 'runtime snapshot: missing, invalid or stale asOf; all fields unknown';

// The reader's numeric process fields become UNKNOWN when the whole read fails.
type UnknownRuntimeSnapshot = Omit<RuntimeSnapshot, 'pid' | 'uptimeSeconds'> & {
  pid: 'UNKNOWN';
  uptimeSeconds: 'UNKNOWN';
};

export interface FleetRuntimeSnapshotResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  snapshot: RuntimeSnapshot | UnknownRuntimeSnapshot;
}

function unknownSnapshot(reason: string): UnknownRuntimeSnapshot {
  return {
    host: 'UNKNOWN', tailnetName: 'UNKNOWN', installedVersion: 'UNKNOWN', sourceVersion: 'UNKNOWN',
    pid: 'UNKNOWN', uptimeSeconds: 'UNKNOWN', platform: 'UNKNOWN', arch: 'UNKNOWN', stateRoot: 'UNKNOWN',
    lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
    coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN' },
    asOf: 'UNKNOWN', reasons: [reason],
  };
}

type SnapshotReadOutcome =
  | { kind: 'snapshot'; snapshot: RuntimeSnapshot }
  | { kind: 'rejected' }
  | { kind: 'timeout' };

export function createFleetRuntimeSnapshotApi(deps: {
  runtimeDeps?: FleetRuntimeDeps;
  now?: () => Date;
  readSnapshot?: (runtimeDeps: FleetRuntimeDeps) => Promise<RuntimeSnapshot>;
  readDeadlineMs?: number;
} = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const read = deps.readSnapshot ?? readRuntimeSnapshot;
  const deadlineMs = deps.readDeadlineMs ?? FLEET_RUNTIME_SNAPSHOT_READ_DEADLINE_MS;
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_RUNTIME_SNAPSHOT_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const runtimeDeps = deps.runtimeDeps ?? defaults;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: SnapshotReadOutcome;
    try {
      outcome = await Promise.race<SnapshotReadOutcome>([
        // Handlers stay attached after a timeout wins, so a late rejection is
        // consumed and can never write a second response or leak unhandled.
        Promise.resolve().then(() => read(runtimeDeps)).then(
          snapshot => ({ kind: 'snapshot' as const, snapshot }),
          (): SnapshotReadOutcome => ({ kind: 'rejected' as const }),
        ),
        new Promise<SnapshotReadOutcome>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'timeout' as const }), deadlineMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // Qualify the reader's observation against completion, never request entry.
    const observedAt = now();
    const generatedAt = observedAt.toISOString();
    const asOf: unknown = outcome.kind === 'snapshot' ? outcome.snapshot?.asOf : undefined;
    const asOfMs = typeof asOf === 'string' ? Date.parse(asOf) : Number.NaN;
    const ageMs = observedAt.getTime() - asOfMs;
    const snapshot: FleetRuntimeSnapshotResponse['snapshot'] = outcome.kind === 'snapshot'
      ? Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= PROCESS_SNAPSHOT_MAX_AGE_MS
        ? outcome.snapshot : unknownSnapshot(STALE_SNAPSHOT_REASON)
      : unknownSnapshot(outcome.kind === 'timeout' ? READ_DEADLINE_REASON : READER_FAILED_REASON);
    const response: FleetRuntimeSnapshotResponse = { v: 1, authority: 'none', generatedAt, snapshot };
    sendJson(res, 200, response);
    return true;
  };
}

export const handleFleetRuntimeSnapshotApi: ApiModule = createFleetRuntimeSnapshotApi();
