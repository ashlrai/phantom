/** Bounded immutable local evidence ledger. Hashes detect corruption, not provider truth. */
import { join, resolve } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory, privateDirectory } from '../universe/artifacts.js';
import { scrubSecrets } from '../util/scrub.js';
import { readReplayWatermark, reserveReplayWatermark } from './replay-watermark.js';
import { readImmutablePrivateRecords, recoverImmutablePrivateRecordStore, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { COMPANION_LIMITS, companionCanonical, companionDigest, companionIdentityEqual, companionTaskId, companionTextDigest,
  type CompanionIdentity, type CompanionLedger, type CompanionRecord, type CompanionReviewer, type CompanionTask,
  type CompanionTaskInput, type CompanionWrite } from './coordination-types.js';

export const companionToken = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value) && scrubSecrets(value) === value;
export const companionHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const companionId = (value: unknown): value is string => typeof value === 'string' && /^ct_[a-f0-9]{32}$/.test(value);
export const companionTime = (value: unknown): value is string => typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function companionText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= maxBytes &&
    ![...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code) || code >= 127 && code <= 159;
    });
}
export function companionSafeText(value: unknown, maxBytes: number): value is string {
  return companionText(value, maxBytes) && scrubSecrets(value) === value;
}
export function companionObject(value: unknown, keys: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const names = Reflect.ownKeys(value);
  return names.every(key => typeof key === 'string' && [...keys, ...optional].includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!) && keys.every(key => Object.hasOwn(value, key));
}
export function validCompanionIdentity(value: unknown): value is CompanionIdentity {
  if (!companionObject(value, ['provider', 'accountId', 'agentId'])) return false;
  const identity = value as CompanionIdentity;
  const reference = (item: unknown): item is string => typeof item === 'string' && item === item.trim() && item.length > 0 && item.length <= 256 &&
    ![...item].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && scrubSecrets(item) === item;
  return typeof identity.provider === 'string' && identity.provider.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.provider) &&
    scrubSecrets(identity.provider) === identity.provider &&
    reference(identity.accountId) && reference(identity.agentId);
}
export function validCompanionReviewer(value: unknown): value is CompanionReviewer {
  const reviewer = value as CompanionReviewer;
  return companionObject(value, ['kind', 'operatorId']) && reviewer.kind === 'operator' && companionToken(reviewer.operatorId) ||
    companionObject(value, ['kind', 'identity']) && reviewer.kind === 'peer' && validCompanionIdentity(reviewer.identity);
}
export function validCompanionTaskInput(value: unknown): value is CompanionTaskInput {
  if (!companionObject(value, ['tenantId', 'projectBindingId', 'taskKey', 'goal', 'acceptance', 'packetDigest', 'capabilityIds'],
    ['deadline', 'maxCostUsd', 'maxAttempts'])) return false;
  const input = value as CompanionTaskInput;
  return companionToken(input.tenantId) && companionToken(input.projectBindingId) && companionToken(input.taskKey) &&
    companionText(input.goal, COMPANION_LIMITS.goalBytes) && companionHash(input.packetDigest) &&
    Array.isArray(input.acceptance) && input.acceptance.length > 0 && input.acceptance.length <= 32 &&
    input.acceptance.every(item => companionText(item, 2000)) && new Set(input.acceptance).size === input.acceptance.length &&
    Array.isArray(input.capabilityIds) && input.capabilityIds.length <= 64 && input.capabilityIds.every(companionToken) &&
    new Set(input.capabilityIds).size === input.capabilityIds.length &&
    (input.deadline === undefined || input.deadline === null || companionTime(input.deadline)) &&
    (input.maxCostUsd === undefined || input.maxCostUsd === null || typeof input.maxCostUsd === 'number' && Number.isFinite(input.maxCostUsd) && input.maxCostUsd >= 0 && input.maxCostUsd <= 1_000_000) &&
    (input.maxAttempts === undefined || Number.isSafeInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= COMPANION_LIMITS.attempts);
}
export function normalizeCompanionTaskInput(input: CompanionTaskInput): Required<CompanionTaskInput> {
  return { ...structuredClone(input), deadline: input.deadline ?? null, maxCostUsd: input.maxCostUsd ?? null, maxAttempts: input.maxAttempts ?? 1 };
}
export function companionTaskScope(task: CompanionTask): Required<CompanionTaskInput> {
  const { tenantId, projectBindingId, taskKey, goal, acceptance, packetDigest, capabilityIds, deadline, maxCostUsd, maxAttempts } = task;
  return { tenantId, projectBindingId, taskKey, goal, acceptance, packetDigest, capabilityIds, deadline, maxCostUsd, maxAttempts };
}
function validTask(task: CompanionTask): boolean {
  if (!companionObject(task, ['tenantId', 'projectBindingId', 'taskKey', 'goal', 'acceptance', 'packetDigest', 'capabilityIds',
    'deadline', 'maxCostUsd', 'maxAttempts', 'id', 'createdAt', 'updatedAt', 'state', 'attempts', 'reports', 'verifications', 'events', 'notification']) ||
    !validCompanionTaskInput(companionTaskScope(task)) || task.id !== companionTaskId(task) ||
    !companionTime(task.createdAt) || !companionTime(task.updatedAt) || task.updatedAt < task.createdAt ||
    !['draft', 'assigned', 'handoff-intent', 'cancel-requested', 'reported', 'verified', 'needs-attention'].includes(task.state) ||
    !Array.isArray(task.attempts) || task.attempts.length > task.maxAttempts ||
    !Array.isArray(task.reports) || task.reports.length > COMPANION_LIMITS.reports ||
    !Array.isArray(task.verifications) || task.verifications.length > COMPANION_LIMITS.verifications ||
    !Array.isArray(task.events) || !task.events.length || task.events.length > COMPANION_LIMITS.events) return false;
  for (const [index, attempt] of task.attempts.entries()) {
    if (!companionObject(attempt, ['id', 'epoch', 'assignee', 'ownerId', 'claimedAt', 'leaseExpiresAt', 'packetDigest', 'contact',
      'handoffAt', 'cancelRequestedAt', 'providerRunId', 'observationReference']) ||
      !companionHash(attempt.id) || attempt.epoch !== index + 1 || !validCompanionIdentity(attempt.assignee) ||
      !companionToken(attempt.ownerId) || !companionTime(attempt.claimedAt) || !companionTime(attempt.leaseExpiresAt) ||
      Date.parse(attempt.leaseExpiresAt) <= Date.parse(attempt.claimedAt) ||
      Date.parse(attempt.leaseExpiresAt) - Date.parse(attempt.claimedAt) > COMPANION_LIMITS.leaseMaxMs ||
      attempt.packetDigest !== task.packetDigest || !['not-contacted', 'intent', 'accepted', 'unknown', 'proved-unstarted', 'cancel-confirmed'].includes(attempt.contact) ||
      !(attempt.handoffAt === null || companionTime(attempt.handoffAt)) || !(attempt.cancelRequestedAt === null || companionTime(attempt.cancelRequestedAt)) ||
      !(attempt.providerRunId === null || companionToken(attempt.providerRunId)) ||
      !(attempt.observationReference === null || companionText(attempt.observationReference, 2000)) ||
      (attempt.contact === 'not-contacted' ? attempt.handoffAt !== null : !attempt.handoffAt &&
        !(['proved-unstarted', 'cancel-confirmed'].includes(attempt.contact) && attempt.cancelRequestedAt !== null && attempt.providerRunId === null)) ||
      (['accepted', 'unknown', 'proved-unstarted', 'cancel-confirmed'].includes(attempt.contact) && !attempt.observationReference) ||
      (attempt.contact === 'accepted' && !attempt.providerRunId) ||
      (attempt.contact === 'cancel-confirmed' && !attempt.cancelRequestedAt) ||
      (index < task.attempts.length - 1 && !['proved-unstarted', 'cancel-confirmed'].includes(attempt.contact) &&
        !(attempt.contact === 'not-contacted' && attempt.handoffAt === null && attempt.cancelRequestedAt !== null && attempt.providerRunId === null))) return false;
  }
  const reportIds = new Set<string>();
  for (const report of task.reports) {
    const attempt = task.attempts.find(item => item.id === report.attemptId);
    if (!companionObject(report, ['id', 'attemptId', 'epoch', 'packetDigest', 'producer', 'result', 'resultDigest', 'report', 'reportDigest',
      'source', 'sourceReference', 'submittedAt', 'stale']) || !companionHash(report.id) || reportIds.has(report.id) || !attempt ||
      report.epoch !== attempt.epoch || !validCompanionIdentity(report.producer) || !companionIdentityEqual(report.producer, attempt.assignee) ||
      !companionHash(report.packetDigest) || !companionSafeText(report.result, COMPANION_LIMITS.resultBytes) ||
      companionTextDigest(report.result) !== report.resultDigest || !companionSafeText(report.report, COMPANION_LIMITS.reportBytes) ||
      companionTextDigest(report.report) !== report.reportDigest || report.source !== 'manual-unverified' ||
      !companionSafeText(report.sourceReference, 2000) || !companionTime(report.submittedAt) || typeof report.stale !== 'boolean' ||
      (!report.stale && (report.packetDigest !== task.packetDigest || attempt !== task.attempts.at(-1)))) return false;
    reportIds.add(report.id);
  }
  const verificationIds = new Set<string>();
  for (const verification of task.verifications) {
    const report = task.reports.find(item => item.id === verification.reportId);
    if (!companionObject(verification, ['id', 'reportId', 'checkedResultDigest', 'reviewer', 'acceptanceMet', 'applied', 'source', 'at']) ||
      !companionHash(verification.id) || verificationIds.has(verification.id) || !report ||
      verification.checkedResultDigest !== report.resultDigest || !validCompanionReviewer(verification.reviewer) ||
      verification.reviewer.kind === 'peer' && companionIdentityEqual(verification.reviewer.identity, report.producer) ||
      typeof verification.acceptanceMet !== 'boolean' || typeof verification.applied !== 'boolean' ||
      verification.applied && (!verification.acceptanceMet || report.stale || report.attemptId !== task.attempts.at(-1)?.id) ||
      verification.source !== 'manual-operator-review' || !companionTime(verification.at)) return false;
    verificationIds.add(verification.id);
  }
  const commandIds = new Set<string>();
  for (const [index, event] of task.events.entries()) {
    if (!companionObject(event, ['seq', 'commandId', 'type', 'at', 'attemptId', 'reportId', 'source']) || event.seq !== index + 1 ||
      !companionToken(event.commandId) || commandIds.has(event.commandId) || !companionTime(event.at) ||
      !['create', 'assign', 'handoff', 'report', 'operator-review', 'cancel', 'notification-ack', 'reconcile'].includes(event.type) ||
      !(event.attemptId === null || task.attempts.some(item => item.id === event.attemptId)) ||
      !(event.reportId === null || reportIds.has(event.reportId)) ||
      event.source !== (event.type === 'reconcile' ? 'host-observed' : 'local-manual')) return false;
    commandIds.add(event.commandId);
  }
  if (task.events[0]?.type !== 'create' || task.events.at(-1)?.at !== task.updatedAt ||
    (task.state === 'verified' && !task.verifications.some(item => item.applied)) ||
    (task.state === 'draft' && task.attempts.length !== 0)) return false;
  return task.notification === null || companionObject(task.notification, ['eventId', 'state', 'reason', 'at']) &&
    companionHash(task.notification.eventId) && ['pending', 'acknowledged'].includes(task.notification.state) &&
    ['needs-review', 'verified', 'needs-attention', 'cancel-requested'].includes(task.notification.reason) && companionTime(task.notification.at);
}
function validLedger(state: CompanionLedger): boolean {
  if (!companionObject(state, ['schemaVersion', 'revision', 'tasks']) || state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) || state.revision < 1 || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks) ||
    Object.keys(state.tasks).length > COMPANION_LIMITS.tasks) return false;
  return Object.entries(state.tasks).every(([id, task]) => companionId(id) && task.id === id && validTask(task));
}
function parse(value: unknown): CompanionRecord | null {
  try {
    if (!companionObject(value, ['schemaVersion', 'revision', 'previousDigest', 'commandId', 'requestDigest', 'taskId', 'state', 'digest'])) return null;
    const record = value as CompanionRecord;
    if (record.schemaVersion !== 1 || !companionToken(record.commandId) || !companionHash(record.requestDigest) ||
      !(record.previousDigest === null || companionHash(record.previousDigest)) || !validLedger(record.state) ||
      record.revision !== record.state.revision || !companionId(record.taskId) || !record.state.tasks[record.taskId] || !companionHash(record.digest)) return null;
    const { digest, ...payload } = record;
    return digest === companionDigest(payload) ? record : null;
  } catch { return null; }
}
const codec: ImmutablePrivateRecordCodec<CompanionRecord> = {
  parse, serialize: value => `${companionCanonical(value)}\n`, recordId: value => String(value.revision),
  recordFileName: value => `${String(value.revision).padStart(16, '0')}.json`, isRecordFileName: name => /^\d{16}\.json$/.test(name),
  stageToken: value => value.digest, equivalent: (a, b) => a.digest === b.digest, compare: (a, b) => a.revision - b.revision,
};
export interface CompanionStoreRead { sourceState: 'healthy' | 'missing' | 'degraded'; state: CompanionLedger | null; records: CompanionRecord[] }
export class CompanionCoordinationStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private config(): ImmutablePrivateRecordStoreConfig<CompanionRecord> {
    return { label: 'Companion coordination', anchorPath: this.directory, rootPath: join(this.directory, 'ledger'), lockFileName: '.records.lock',
      maxRecordBytes: COMPANION_LIMITS.recordBytes, defaultMaxFiles: COMPANION_LIMITS.records, hardMaxFiles: COMPANION_LIMITS.records,
      defaultMaxBytes: COMPANION_LIMITS.ledgerBytes, hardMaxBytes: COMPANION_LIMITS.ledgerBytes, codecForRead: () => codec, codecForWrite: () => codec };
  }
  read(): CompanionStoreRead {
    try {
      inspectPrivateDirectory(this.directory);
      const watermark = readReplayWatermark(this.directory, { maxRecords: COMPANION_LIMITS.records });
      if (watermark.sourceState === 'degraded') return { sourceState: 'degraded', state: null, records: [] };
      const read = readImmutablePrivateRecords(this.config(), { requireComplete: true });
      if (read.sourceState === 'missing') return { sourceState: watermark.sourceState === 'missing' ? 'missing' : 'degraded', state: null, records: [] };
      if (!read.complete || read.sourceState !== 'healthy') return { sourceState: 'degraded', state: null, records: [] };
      if (watermark.revision !== read.records.length || watermark.ledgerDigest !== (read.records.at(-1)?.digest ?? null)) {
        return { sourceState: 'degraded', state: null, records: [] };
      }
      const commands = new Set<string>();
      for (const [index, record] of read.records.entries()) {
        const previous = read.records[index - 1];
        if (record.revision !== index + 1 || record.previousDigest !== (previous?.digest ?? null) || commands.has(record.commandId)) {
          return { sourceState: 'degraded', state: null, records: [] };
        }
        // Prior immutable scope and event history may never disappear or be rewritten.
        if (previous && Object.entries(previous.state.tasks).some(([id, task]) => {
          const next = record.state.tasks[id];
          return !next || companionCanonical(companionTaskScope(task)) !== companionCanonical(companionTaskScope(next)) ||
            companionCanonical(next.events.slice(0, task.events.length)) !== companionCanonical(task.events) ||
            next.attempts.length < task.attempts.length || task.attempts.some((attempt, index) => {
              const candidate = next.attempts[index];
              if (!candidate) return true;
              const fixed = (value: typeof attempt) => {
                const { contact: _contact, handoffAt: _handoff, cancelRequestedAt: _cancel, providerRunId: _run,
                  observationReference: _reference, ...immutable } = value; return immutable;
              };
              return companionCanonical(fixed(attempt)) !== companionCanonical(fixed(candidate)) ||
                attempt.handoffAt !== null && candidate.handoffAt !== attempt.handoffAt ||
                attempt.cancelRequestedAt !== null && candidate.cancelRequestedAt !== attempt.cancelRequestedAt ||
                attempt.providerRunId !== null && candidate.providerRunId !== attempt.providerRunId ||
                ['proved-unstarted', 'cancel-confirmed'].includes(attempt.contact) && candidate.contact !== attempt.contact;
            }) || next.reports.length < task.reports.length || task.reports.some((report, index) => {
              const candidate = next.reports[index];
              const fixed = (value: typeof report) => { const { stale: _stale, ...immutable } = value; return immutable; };
              return !candidate || companionCanonical(fixed(report)) !== companionCanonical(fixed(candidate)) || report.stale && !candidate.stale;
            }) || companionCanonical(next.verifications.slice(0, task.verifications.length)) !== companionCanonical(task.verifications);
        })) return { sourceState: 'degraded', state: null, records: [] };
        commands.add(record.commandId);
      }
      return { sourceState: read.records.length ? 'healthy' : 'missing', state: read.records.at(-1)?.state ?? null, records: read.records };
    } catch (error) { return { sourceState: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', state: null, records: [] }; }
  }
  replay(commandId: string, request: unknown): CompanionWrite | null {
    const read = this.read();
    if (read.sourceState === 'degraded') return { ok: false, reason: 'unavailable', dispatchAuthorized: false };
    const record = read.records.find(value => value.commandId === commandId);
    if (!record) return null;
    if (record.requestDigest !== companionDigest(request)) return { ok: false, reason: 'conflict', dispatchAuthorized: false };
    return { ok: true, disposition: 'replayed', revision: record.revision, taskId: record.taskId,
      task: structuredClone(record.state.tasks[record.taskId]!), dispatchAuthorized: false };
  }
  transact(commandId: string, expectedRevision: number, request: unknown, taskId: string,
    update: (state: CompanionLedger) => void): CompanionWrite {
    const fail = (reason: 'invalid' | 'conflict' | 'held' | 'not-found' | 'unavailable' | 'capacity'): CompanionWrite => ({ ok: false, reason, dispatchAuthorized: false });
    if (!companionToken(commandId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !companionId(taskId)) return fail('invalid');
    try { privateDirectory(this.directory); } catch { return fail('unavailable'); }
    const acquired = acquireLocalStoreLockWithOutcome(join(this.directory, '.coordination.lock'), 0, { anchorPath: this.directory, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return fail(acquired.state === 'contended' ? 'conflict' : 'unavailable');
    try {
      const requestDigest = companionDigest(request);
      if (this.read().sourceState === 'degraded') return fail('unavailable');
      const recovery = recoverImmutablePrivateRecordStore(this.config());
      if (!['clean', 'recovered', 'missing'].includes(recovery)) return fail('unavailable');
      const read = this.read();
      if (read.sourceState === 'degraded') return fail('unavailable');
      const replay = read.records.find(record => record.commandId === commandId);
      if (replay) return replay.requestDigest !== requestDigest ? fail('conflict') : {
        ok: true, disposition: 'replayed', revision: replay.revision, taskId: replay.taskId,
        task: structuredClone(replay.state.tasks[replay.taskId]!), dispatchAuthorized: false };
      if ((read.state?.revision ?? 0) !== expectedRevision) return fail('conflict');
      if (read.records.length >= COMPANION_LIMITS.records) return fail('capacity');
      const state: CompanionLedger = structuredClone(read.state ?? { schemaVersion: 1, revision: 0, tasks: {} });
      try { update(state); } catch (error) {
        const reason = (error as { reason?: string }).reason;
        return fail(['invalid', 'conflict', 'held', 'not-found', 'capacity'].includes(reason ?? '') ? reason as 'held' : 'invalid');
      }
      state.revision += 1;
      const payload = { schemaVersion: 1 as const, revision: state.revision, previousDigest: read.records.at(-1)?.digest ?? null,
        commandId, requestDigest, taskId, state };
      const record = { ...payload, digest: companionDigest(payload) };
      if (!parse(record)) return fail('invalid');
      if (Buffer.byteLength(codec.serialize(record)) > COMPANION_LIMITS.recordBytes) return fail('capacity');
      if (!ownsLocalStoreLock(acquired.lock)) return fail('unavailable');
      const reserved = reserveReplayWatermark(this.directory, { revision: record.revision, ledgerDigest: record.digest,
        previousLedgerDigest: record.previousDigest }, { maxRecords: COMPANION_LIMITS.records });
      if (!['recorded', 'replayed'].includes(reserved)) return fail('unavailable');
      const disposition = writeImmutablePrivateRecord(this.config(), record, { prepublish: () => ownsLocalStoreLock(acquired.lock) });
      if (!['recorded', 'replayed'].includes(disposition)) return fail(disposition === 'conflicted' ? 'conflict' : 'unavailable');
      return { ok: true, disposition: disposition as 'recorded' | 'replayed', revision: state.revision, taskId,
        task: structuredClone(state.tasks[taskId]!), dispatchAuthorized: false };
    } catch { return fail('unavailable'); }
    finally { releaseLocalStoreLock(acquired.lock); }
  }
}
