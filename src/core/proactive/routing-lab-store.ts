/** Durable offline receipts, with intent-before-evaluation and conservative interruption replay. */
import { join, resolve } from 'node:path';
import { inspectPrivateDirectory, privateDirectory } from '../universe/artifacts.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, recoverImmutablePrivateRecordStore, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { companionCanonical, companionDigest } from './coordination-types.js';
import { companionHash, companionObject, companionSafeText, companionTime, companionToken } from './coordination-store.js';
import { readReplayWatermark, reserveReplayWatermark } from './replay-watermark.js';
import type { RoutingLabCommand, RoutingLabEvaluation, RoutingLabPreferenceProposal, RoutingLabRecord, RoutingLabState, RoutingLabView, RoutingLabWrite } from './routing-lab-types.js';

export const ROUTING_LAB_LIMITS = Object.freeze({ evaluations: 64, proposals: 64, cases: 32, rows: 512, choices: 255,
  records: 1024, recordBytes: 1024 * 1024, aggregateBytes: 64 * 1024 * 1024 });
export function routingLabEvaluationId(requestId: string): string { return `rl_${companionDigest(['routing-lab', requestId]).slice(0, 32)}`; }
export const routingLabId = (value: unknown): value is string => typeof value === 'string' && /^r[lp]_[a-f0-9]{32}$/.test(value);
export const routingLabReference = (value: unknown): value is string => companionSafeText(value, 1024) && value === value.trim() &&
  ![...value].some(character => character.charCodeAt(0) < 32);
function validEvaluation(evaluation: RoutingLabEvaluation): boolean {
  if (!companionObject(evaluation, ['id', 'requestId', 'kind', 'mode', 'status', 'inputDigest', 'snapshotDigest', 'policyId', 'modelId', 'adapterMode',
    'createdAt', 'completedAt', 'localDurationMs', 'providerLatencyMs', 'cases', 'summary', 'executionAuthorized', 'notes']) ||
    evaluation.id !== routingLabEvaluationId(evaluation.requestId) || !companionToken(evaluation.requestId) ||
    !['preview', 'benchmark'].includes(evaluation.kind) || evaluation.mode !== (evaluation.kind === 'preview' ? 'shadow-readonly' : 'fixture') ||
    !['uncertain', 'completed', 'aborted'].includes(evaluation.status) || !companionHash(evaluation.inputDigest) || !companionHash(evaluation.snapshotDigest) ||
    evaluation.policyId !== 'companion-routing-lab-v1' || evaluation.modelId !== 'jev-1.13.0' ||
    evaluation.adapterMode !== (evaluation.mode === 'fixture' ? 'offline-fixture' : 'deterministic-only') ||
    !companionTime(evaluation.createdAt) || !(evaluation.completedAt === null || companionTime(evaluation.completedAt)) ||
    evaluation.providerLatencyMs !== null || evaluation.executionAuthorized !== false ||
    !(evaluation.localDurationMs === null || Number.isFinite(evaluation.localDurationMs) && evaluation.localDurationMs >= 0) ||
    !Array.isArray(evaluation.cases) || evaluation.cases.length > ROUTING_LAB_LIMITS.cases ||
    !Array.isArray(evaluation.notes) || evaluation.notes.length > 16 || !evaluation.notes.every(note => companionSafeText(note, 1000))) return false;
  if (evaluation.status === 'uncertain' && (evaluation.cases.length > 0 || evaluation.completedAt !== null || evaluation.localDurationMs !== null) ||
    evaluation.status !== 'uncertain' && (evaluation.completedAt === null || evaluation.localDurationMs === null)) return false;
  for (const item of evaluation.cases) {
    if (!companionObject(item, ['caseId', 'taskDigest', 'snapshotDigest', 'candidates', 'selectedResourceId', 'path', 'fallbackReason', 'expectedResourceId',
      'passed', 'notes', 'localDurationMs', 'providerLatencyMs', 'executionAuthorized']) || !companionToken(item.caseId) ||
      !companionHash(item.taskDigest) || !companionHash(item.snapshotDigest) || item.executionAuthorized !== false || item.providerLatencyMs !== null ||
      !Number.isFinite(item.localDurationMs) || item.localDurationMs < 0 || !['deterministic', 'fixture-advice', 'held', 'aborted'].includes(item.path) ||
      !(item.fallbackReason === null || companionToken(item.fallbackReason)) ||
      !(item.selectedResourceId === null || routingLabReference(item.selectedResourceId)) ||
      !(item.expectedResourceId === null || routingLabReference(item.expectedResourceId)) || !(item.passed === null || typeof item.passed === 'boolean') ||
      !Array.isArray(item.candidates) || item.candidates.length > ROUTING_LAB_LIMITS.rows ||
      !Array.isArray(item.notes) || item.notes.length > 16 || !item.notes.every(note => companionSafeText(note, 1000))) return false;
    const ids = new Set<string>();
    for (const candidate of item.candidates) {
      if (!companionObject(candidate, ['resourceId', 'label', 'qualification', 'holds', 'matchedCapabilityIds', 'sourceMode', 'executionAuthorized']) ||
        !routingLabReference(candidate.resourceId) || ids.has(candidate.resourceId) || !companionSafeText(candidate.label, 200) ||
        !['planning-candidate', 'qualified-shadow-fixture', 'held'].includes(candidate.qualification) || candidate.sourceMode !== evaluation.mode ||
        candidate.executionAuthorized !== false || !Array.isArray(candidate.holds) || candidate.holds.length > 32 || !candidate.holds.every(companionToken) ||
        !Array.isArray(candidate.matchedCapabilityIds) || candidate.matchedCapabilityIds.length > 64 || !candidate.matchedCapabilityIds.every(companionToken) ||
        candidate.qualification === 'qualified-shadow-fixture' && (evaluation.mode !== 'fixture' || candidate.holds.length !== 0)) return false;
      ids.add(candidate.resourceId);
    }
    if (item.selectedResourceId !== null && !item.candidates.some(candidate => candidate.resourceId === item.selectedResourceId &&
      candidate.qualification !== 'held' && candidate.holds.length === 0) ||
      ['held', 'aborted'].includes(item.path) && item.selectedResourceId !== null) return false;
  }
  const summary = evaluation.summary;
  if (!companionObject(summary, ['total', 'evaluated', 'expected', 'passed', 'failed', 'coverage']) ||
    ![summary.total, summary.evaluated, summary.expected, summary.passed, summary.failed].every(value => Number.isSafeInteger(value) && value >= 0) ||
    summary.total > ROUTING_LAB_LIMITS.cases || summary.evaluated !== evaluation.cases.length || summary.evaluated > summary.total ||
    summary.expected !== evaluation.cases.filter(item => item.passed !== null).length || summary.passed !== evaluation.cases.filter(item => item.passed === true).length ||
    summary.failed !== evaluation.cases.filter(item => item.passed === false).length || summary.coverage !== (summary.total ? summary.evaluated / summary.total : 0)) return false;
  return true;
}
function validProposal(proposal: RoutingLabPreferenceProposal, state: RoutingLabState): boolean {
  return companionObject(proposal, ['id', 'evaluationId', 'resourceId', 'reason', 'state', 'createdAt', 'withdrawnAt', 'executionAuthorized']) &&
    routingLabId(proposal.id) && state.evaluations.some(value => value.id === proposal.evaluationId && value.status === 'completed' &&
      value.cases.some(item => item.candidates.some(candidate => candidate.resourceId === proposal.resourceId && candidate.qualification !== 'held'))) &&
    routingLabReference(proposal.resourceId) && companionSafeText(proposal.reason, 1000) && ['proposed', 'withdrawn'].includes(proposal.state) &&
    companionTime(proposal.createdAt) && (proposal.state === 'proposed' ? proposal.withdrawnAt === null : companionTime(proposal.withdrawnAt)) && proposal.executionAuthorized === false;
}
function parse(value: unknown): RoutingLabRecord | null {
  try {
    if (!companionObject(value, ['schemaVersion', 'revision', 'previousDigest', 'requestId', 'requestDigest', 'phase', 'subjectId', 'state', 'digest'])) return null;
    const record = value as RoutingLabRecord; const state = record.state;
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 || !companionToken(record.requestId) ||
      !companionHash(record.requestDigest) || !(record.previousDigest === null || companionHash(record.previousDigest)) ||
      !['intent', 'settled', 'proposal'].includes(record.phase) || !routingLabId(record.subjectId) ||
      !companionObject(state, ['schemaVersion', 'revision', 'evaluations', 'proposals']) || state.schemaVersion !== 1 || state.revision !== record.revision ||
      !Array.isArray(state.evaluations) || state.evaluations.length > ROUTING_LAB_LIMITS.evaluations || !state.evaluations.every(validEvaluation) ||
      new Set(state.evaluations.map(item => item.id)).size !== state.evaluations.length ||
      !Array.isArray(state.proposals) || state.proposals.length > ROUTING_LAB_LIMITS.proposals || !state.proposals.every(proposal => validProposal(proposal, state)) ||
      new Set(state.proposals.map(item => item.id)).size !== state.proposals.length || !companionHash(record.digest)) return null;
    if (record.phase === 'proposal' ? !state.proposals.some(item => item.id === record.subjectId)
      : !state.evaluations.some(item => item.id === record.subjectId && (record.phase === 'intent' ? item.status === 'uncertain' : item.status !== 'uncertain'))) return null;
    const { digest, ...payload } = record;
    return digest === companionDigest(payload) ? record : null;
  } catch { return null; }
}
const codec: ImmutablePrivateRecordCodec<RoutingLabRecord> = {
  parse, serialize: value => `${companionCanonical(value)}\n`, recordId: value => String(value.revision),
  recordFileName: value => `${String(value.revision).padStart(16, '0')}.json`, isRecordFileName: name => /^\d{16}\.json$/.test(name),
  stageToken: value => value.digest, equivalent: (a, b) => a.digest === b.digest, compare: (a, b) => a.revision - b.revision,
};
export class RoutingLabStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private config(): ImmutablePrivateRecordStoreConfig<RoutingLabRecord> {
    return { label: 'Offline routing lab', anchorPath: this.directory, rootPath: join(this.directory, 'ledger'), lockFileName: '.records.lock',
      maxRecordBytes: ROUTING_LAB_LIMITS.recordBytes, defaultMaxFiles: ROUTING_LAB_LIMITS.records, hardMaxFiles: ROUTING_LAB_LIMITS.records,
      defaultMaxBytes: ROUTING_LAB_LIMITS.aggregateBytes, hardMaxBytes: ROUTING_LAB_LIMITS.aggregateBytes, codecForRead: () => codec, codecForWrite: () => codec };
  }
  read(): { view: RoutingLabView; records: RoutingLabRecord[] } {
    const empty = (sourceState: RoutingLabView['sourceState']) => ({ view: { schemaVersion: 1 as const, revision: 0, sourceState,
      evaluations: [], proposals: [], executionAuthorized: false as const }, records: [] });
    try {
      inspectPrivateDirectory(this.directory); const read = readImmutablePrivateRecords(this.config(), { requireComplete: true });
      const watermark = readReplayWatermark(this.directory, { maxRecords: ROUTING_LAB_LIMITS.records });
      if (watermark.sourceState === 'degraded') return empty('degraded');
      const last = read.records.at(-1);
      if (last ? watermark.sourceState !== 'healthy' || watermark.revision !== last.revision || watermark.ledgerDigest !== last.digest
        : watermark.sourceState !== 'missing') return empty('degraded');
      if (read.sourceState === 'missing') return empty('missing');
      if (!read.complete || read.sourceState !== 'healthy') return empty('degraded');
      const intents = new Set<string>(); const settled = new Set<string>();
      for (const [index, record] of read.records.entries()) {
        const prior = read.records[index - 1];
        if (record.revision !== index + 1 || record.previousDigest !== (prior?.digest ?? null)) return empty('degraded');
        if (record.phase === 'settled') {
          const intent = read.records.find(item => item.requestId === record.requestId && item.phase === 'intent');
          if (!intent || settled.has(record.requestId) || intent.requestDigest !== record.requestDigest || intent.subjectId !== record.subjectId) return empty('degraded');
          settled.add(record.requestId);
        } else {
          if (intents.has(record.requestId)) return empty('degraded'); intents.add(record.requestId);
        }
        if (prior && prior.state.evaluations.some(evaluation => {
          const next = record.state.evaluations.find(item => item.id === evaluation.id);
          if (!next) return true;
          if (evaluation.status !== 'uncertain') return companionCanonical(next) !== companionCanonical(evaluation);
          const fixed = (item: RoutingLabEvaluation) => { const { status: _status, completedAt: _at, localDurationMs: _duration,
            cases: _cases, summary: _summary, notes: _notes, ...rest } = item; return rest; };
          return companionCanonical(fixed(next)) !== companionCanonical(fixed(evaluation));
        })) return empty('degraded');
        if (prior && prior.state.proposals.some(proposal => {
          const next = record.state.proposals.find(item => item.id === proposal.id); if (!next) return true;
          const fixed = (item: RoutingLabPreferenceProposal) => { const { state: _state, withdrawnAt: _at, ...rest } = item; return rest; };
          return companionCanonical(fixed(proposal)) !== companionCanonical(fixed(next)) ||
            proposal.state === 'withdrawn' && companionCanonical(proposal) !== companionCanonical(next);
        })) return empty('degraded');
      }
      const state = read.records.at(-1)?.state;
      return state ? { view: { ...structuredClone(state), sourceState: 'healthy', executionAuthorized: false }, records: read.records } : empty('missing');
    } catch (error) { return empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded'); }
  }
  replay(command: RoutingLabCommand): RoutingLabWrite | null {
    const read = this.read(); if (read.view.sourceState === 'degraded') return this.fail('unavailable');
    const record = read.records.find(item => item.requestId === command.requestId);
    if (!record) return null;
    if (record.requestDigest !== companionDigest(command)) return this.fail('conflict');
    // Intent-only interruptions remain uncertain; never invoke the adapter again.
    const latest = read.records.filter(item => item.requestId === command.requestId).at(-1)!;
    return this.result(latest, 'replayed');
  }
  fail(reason: 'invalid' | 'conflict' | 'held' | 'unavailable' | 'capacity'): RoutingLabWrite { return { ok: false, reason, executionAuthorized: false }; }
  private result(record: RoutingLabRecord, disposition: 'recorded' | 'replayed'): RoutingLabWrite {
    return { ok: true, disposition, revision: record.revision,
      evaluation: structuredClone(record.state.evaluations.find(item => item.id === record.subjectId) ?? null),
      proposal: structuredClone(record.state.proposals.find(item => item.id === record.subjectId) ?? null), executionAuthorized: false };
  }
  append(command: RoutingLabCommand, phase: RoutingLabRecord['phase'], subjectId: string,
    mutate: (state: RoutingLabState) => void): RoutingLabWrite {
    try { privateDirectory(this.directory); } catch { return this.fail('unavailable'); }
    const lock = acquireLocalStoreLockWithOutcome(join(this.directory, '.lab.lock'), 0, { anchorPath: this.directory, exactPrivateStorage: true });
    if (lock.state !== 'acquired') return this.fail(lock.state === 'contended' ? 'conflict' : 'unavailable');
    try {
      // Reservation gaps and truncated prefixes are never repaired into fresh permission.
      if (this.read().view.sourceState === 'degraded') return this.fail('unavailable');
      if (!['clean', 'recovered', 'missing'].includes(recoverImmutablePrivateRecordStore(this.config()))) return this.fail('unavailable');
      const read = this.read(); if (read.view.sourceState === 'degraded') return this.fail('unavailable');
      if (phase !== 'settled') { const replay = this.replay(command); if (replay) return replay;
        if (read.view.revision !== command.expectedRevision) return this.fail('conflict'); }
      else if (!read.records.some(item => item.requestId === command.requestId && item.phase === 'intent' && item.requestDigest === companionDigest(command)) ||
        read.records.some(item => item.requestId === command.requestId && item.phase === 'settled')) return this.fail('conflict');
      if (read.records.length >= ROUTING_LAB_LIMITS.records) return this.fail('capacity');
      const state: RoutingLabState = { schemaVersion: 1, revision: read.view.revision, evaluations: structuredClone(read.view.evaluations), proposals: structuredClone(read.view.proposals) };
      try { mutate(state); } catch { return this.fail('held'); } state.revision += 1;
      const payload = { schemaVersion: 1 as const, revision: state.revision, previousDigest: read.records.at(-1)?.digest ?? null,
        requestId: command.requestId, requestDigest: companionDigest(command), phase, subjectId, state };
      const record = { ...payload, digest: companionDigest(payload) };
      if (!parse(record)) return this.fail('invalid'); if (Buffer.byteLength(codec.serialize(record)) > ROUTING_LAB_LIMITS.recordBytes) return this.fail('capacity');
      if (!ownsLocalStoreLock(lock.lock) || reserveReplayWatermark(this.directory,
        { revision: record.revision, ledgerDigest: record.digest, previousLedgerDigest: record.previousDigest },
        { maxRecords: ROUTING_LAB_LIMITS.records }) !== 'recorded') return this.fail('unavailable');
      const disposition = writeImmutablePrivateRecord(this.config(), record, { prepublish: () => ownsLocalStoreLock(lock.lock) });
      return ['recorded', 'replayed'].includes(disposition) ? this.result(record, disposition as 'recorded' | 'replayed') : this.fail('unavailable');
    } catch { return this.fail('unavailable'); } finally { releaseLocalStoreLock(lock.lock); }
  }
}
