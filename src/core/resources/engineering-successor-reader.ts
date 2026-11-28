/** Fixed read-only journal transport; never shares the effect worker's queue. */
import { isAbsolute, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { createBoundedReadWorker, ReadProjectionError } from '../web/bounded-read-worker.js';
import { hasExactEngineeringKeys as exact, isEngineeringHash, isEngineeringId,
  isEngineeringIsoTimestamp, resolveTsxWorkerEntrypoint } from './engineering-shared.js';
import type { ResourceEngineeringSuccessorJournalScope } from './engineering-successor-store.js';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot } from './engineering-successor-coordinator-types.js';

export interface EngineeringSuccessorObservation {
  snapshot: ResourceEngineeringSuccessorCoordinatorSnapshot;
  sampledAt: string;
  recordsDigest: string;
}
export interface EngineeringSuccessorReader {
  read(): Promise<EngineeringSuccessorObservation>;
  close(): Promise<void>;
}
function observation(value: unknown, scope: ResourceEngineeringSuccessorJournalScope): EngineeringSuccessorObservation {
  const invalid = () => new ReadProjectionError('Successor observation could not be verified');
  const serialized = canonicalEvidencePackJsonV3(value);
  if (serialized === null || Buffer.byteLength(serialized) > 32 * 1024) throw invalid();
  const result = JSON.parse(serialized) as unknown;
  if (!exact(result, ['snapshot', 'sampledAt', 'recordsDigest']) ||
      !isEngineeringIsoTimestamp(result.sampledAt) || !isEngineeringHash(result.recordsDigest)) throw invalid();
  const snapshot = result.snapshot;
  if (!exact(snapshot, ['schemaVersion', 'supervisionId', 'profileId', 'configDigest', 'deadlineAt', 'state', 'maxSuccessors', 'entries']) ||
      snapshot.schemaVersion !== 1 || snapshot.supervisionId !== scope.config.supervisionId || snapshot.profileId !== scope.config.profileId ||
      snapshot.configDigest !== scope.expectedEnrollment.configDigest || snapshot.deadlineAt !== scope.expectedEnrollment.deadlineAt ||
      snapshot.state !== 'observing' || snapshot.maxSuccessors !== scope.config.maxSuccessors ||
      !Array.isArray(snapshot.entries) || snapshot.entries.length > scope.config.maxSuccessors) throw invalid();
  const sources = new Set<string>(); const tasks = new Set<string>();
  for (const row of snapshot.entries) {
    if (!exact(row, ['sourceEnrollmentId', 'proposalTaskId', 'successorId', 'state', 'reason']) ||
        !isEngineeringId(row.sourceEnrollmentId) ||
        typeof row.proposalTaskId !== 'string' || !/^proposal-[a-f0-9]{48}$/.test(row.proposalTaskId) ||
        row.successorId !== `successor-${row.proposalTaskId.slice(9)}` || row.reason !== null ||
        typeof row.state !== 'string' || !['intent-recorded', 'proposed', 'stopped', 'prepared', 'admitted'].includes(row.state) ||
        sources.has(row.sourceEnrollmentId) || tasks.has(row.proposalTaskId)) throw invalid();
    sources.add(row.sourceEnrollmentId); tasks.add(row.proposalTaskId);
  }
  return result as unknown as EngineeringSuccessorObservation;
}
const entrypoint = (): URL =>
  resolveTsxWorkerEntrypoint(import.meta.url, '/engineering-successor-reader.ts', 'engineering-successor-read-worker');

export function createEngineeringSuccessorReader(input: {
  scope: ResourceEngineeringSuccessorJournalScope; configFile: string;
}): EngineeringSuccessorReader {
  const serialized = canonicalEvidencePackJsonV3(input);
  if (serialized === null || Buffer.byteLength(serialized) > 32 * 1024) throw new ReadProjectionError('Invalid successor observation scope');
  const captured = JSON.parse(serialized) as typeof input;
  if (Object.keys(captured).length !== 2 || !captured.scope || typeof captured.configFile !== 'string' ||
      !isAbsolute(captured.configFile) || resolve(captured.configFile) !== captured.configFile) throw new ReadProjectionError('Invalid successor observation scope');
  const reader = createBoundedReadWorker({ workerEntrypoint: entrypoint, workerData: { schemaVersion: 1, ...captured },
    normalize(kind, payload) {
      if (kind !== 'snapshot' || !Number.isSafeInteger(payload) || Number(payload) < 1) throw new ReadProjectionError('Invalid successor observation request');
      return payload;
    } });
  let sequence = 0;
  // The shared reader coalesces equal payloads. Unique internal tokens ensure
  // a later operator request cannot join a sample begun before that request.
  return { async read() {
    const requestedAt = Date.now();
    const result = observation(await reader.read('snapshot', ++sequence), captured.scope);
    const sampledAt = Date.parse(result.sampledAt);
    if (sampledAt < requestedAt || sampledAt > Date.now()) throw new ReadProjectionError('Successor observation sample is not current');
    return result;
  }, close: () => reader.close() };
}
