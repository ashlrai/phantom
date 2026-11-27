/** Durable offline receipts, with intent-before-evaluation and conservative interruption replay. */
import { resolve } from 'node:path';
import { companionDigest } from './coordination-types.js';
import { companionSafeText, companionToken } from './coordination-store.js';
import {
  commitWatermarkedLedgerRecord, createRevisionRecordCodec, createWatermarkedLedgerConfig, readWatermarkedLedger,
} from './replay-watermark.js';
import type {
  RoutingLabCandidate, RoutingLabCommand, RoutingLabEvaluation, RoutingLabPreferenceProposal, RoutingLabRecord,
  RoutingLabState, RoutingLabView, RoutingLabWrite,
} from './routing-lab-types.js';
import { canonicalJson, hasNoControlChars, hasPlainDataKeys, isCanonicalIsoTimestamp, isSha256Hex } from './validation.js';

export const ROUTING_LAB_POLICY = 'companion-routing-lab-v1' as const;
export const ROUTING_LAB_MODEL = 'jev-1.13.0' as const;
export const ROUTING_LAB_LIMITS = Object.freeze({ evaluations: 64, proposals: 64, cases: 32, rows: 512, choices: 255,
  records: 1024, recordBytes: 1024 * 1024, aggregateBytes: 64 * 1024 * 1024 });
export function routingLabEvaluationId(requestId: string): string { return `rl_${companionDigest(['routing-lab', requestId]).slice(0, 32)}`; }
export const routingLabId = (value: unknown): value is string => typeof value === 'string' && /^r[lp]_[a-f0-9]{32}$/.test(value);
export const routingLabReference = (value: unknown): value is string => companionSafeText(value, 1024) && value === value.trim() && hasNoControlChars(value);
export function isQualifiedRoutingCandidate(candidate: Pick<RoutingLabCandidate, 'qualification' | 'holds'>): boolean {
  return candidate.qualification !== 'held' && candidate.holds.length === 0;
}
export function hasEligibleRoutingCandidate(state: Pick<RoutingLabState, 'evaluations'>, evaluationId: string, resourceId: string): boolean {
  return state.evaluations.some(evaluation => evaluation.id === evaluationId && evaluation.status === 'completed' &&
    evaluation.cases.some(item => item.candidates.some(candidate => candidate.resourceId === resourceId && candidate.qualification !== 'held')));
}
function validEvaluation(evaluation: RoutingLabEvaluation): boolean {
  if (!hasPlainDataKeys(evaluation, ['id', 'requestId', 'kind', 'mode', 'status', 'inputDigest', 'snapshotDigest', 'policyId', 'modelId', 'adapterMode',
    'createdAt', 'completedAt', 'localDurationMs', 'providerLatencyMs', 'cases', 'summary', 'executionAuthorized', 'notes']) ||
    evaluation.id !== routingLabEvaluationId(evaluation.requestId) || !companionToken(evaluation.requestId) ||
    !['preview', 'benchmark'].includes(evaluation.kind) || evaluation.mode !== (evaluation.kind === 'preview' ? 'shadow-readonly' : 'fixture') ||
    !['uncertain', 'completed', 'aborted'].includes(evaluation.status) || !isSha256Hex(evaluation.inputDigest) || !isSha256Hex(evaluation.snapshotDigest) ||
    evaluation.policyId !== ROUTING_LAB_POLICY || evaluation.modelId !== ROUTING_LAB_MODEL ||
    evaluation.adapterMode !== (evaluation.mode === 'fixture' ? 'offline-fixture' : 'deterministic-only') ||
    !isCanonicalIsoTimestamp(evaluation.createdAt) || !(evaluation.completedAt === null || isCanonicalIsoTimestamp(evaluation.completedAt)) ||
    evaluation.providerLatencyMs !== null || evaluation.executionAuthorized !== false ||
    !(evaluation.localDurationMs === null || Number.isFinite(evaluation.localDurationMs) && evaluation.localDurationMs >= 0) ||
    !Array.isArray(evaluation.cases) || evaluation.cases.length > ROUTING_LAB_LIMITS.cases ||
    !Array.isArray(evaluation.notes) || evaluation.notes.length > 16 || !evaluation.notes.every(note => companionSafeText(note, 1000))) return false;
  if (evaluation.status === 'uncertain' && (evaluation.cases.length > 0 || evaluation.completedAt !== null || evaluation.localDurationMs !== null) ||
    evaluation.status !== 'uncertain' && (evaluation.completedAt === null || evaluation.localDurationMs === null)) return false;
  for (const item of evaluation.cases) {
    if (!hasPlainDataKeys(item, ['caseId', 'taskDigest', 'snapshotDigest', 'candidates', 'selectedResourceId', 'path', 'fallbackReason', 'expectedResourceId',
      'passed', 'notes', 'localDurationMs', 'providerLatencyMs', 'executionAuthorized']) || !companionToken(item.caseId) ||
      !isSha256Hex(item.taskDigest) || !isSha256Hex(item.snapshotDigest) || item.executionAuthorized !== false || item.providerLatencyMs !== null ||
      !Number.isFinite(item.localDurationMs) || item.localDurationMs < 0 || !['deterministic', 'fixture-advice', 'held', 'aborted'].includes(item.path) ||
      !(item.fallbackReason === null || companionToken(item.fallbackReason)) ||
      !(item.selectedResourceId === null || routingLabReference(item.selectedResourceId)) ||
      !(item.expectedResourceId === null || routingLabReference(item.expectedResourceId)) || !(item.passed === null || typeof item.passed === 'boolean') ||
      !Array.isArray(item.candidates) || item.candidates.length > ROUTING_LAB_LIMITS.rows ||
      !Array.isArray(item.notes) || item.notes.length > 16 || !item.notes.every(note => companionSafeText(note, 1000))) return false;
    const ids = new Set<string>();
    for (const candidate of item.candidates) {
      if (!hasPlainDataKeys(candidate, ['resourceId', 'label', 'qualification', 'holds', 'matchedCapabilityIds', 'sourceMode', 'executionAuthorized']) ||
        !routingLabReference(candidate.resourceId) || ids.has(candidate.resourceId) || !companionSafeText(candidate.label, 200) ||
        !['planning-candidate', 'qualified-shadow-fixture', 'held'].includes(candidate.qualification) || candidate.sourceMode !== evaluation.mode ||
        candidate.executionAuthorized !== false || !Array.isArray(candidate.holds) || candidate.holds.length > 32 || !candidate.holds.every(companionToken) ||
        !Array.isArray(candidate.matchedCapabilityIds) || candidate.matchedCapabilityIds.length > 64 || !candidate.matchedCapabilityIds.every(companionToken) ||
        candidate.qualification === 'qualified-shadow-fixture' && (evaluation.mode !== 'fixture' || candidate.holds.length !== 0)) return false;
      ids.add(candidate.resourceId);
    }
    if (item.selectedResourceId !== null && !item.candidates.some(candidate => candidate.resourceId === item.selectedResourceId &&
      isQualifiedRoutingCandidate(candidate)) ||
      ['held', 'aborted'].includes(item.path) && item.selectedResourceId !== null) return false;
  }
  const summary = evaluation.summary;
  if (!hasPlainDataKeys(summary, ['total', 'evaluated', 'expected', 'passed', 'failed', 'coverage']) ||
    ![summary.total, summary.evaluated, summary.expected, summary.passed, summary.failed].every(value => Number.isSafeInteger(value) && value >= 0) ||
    summary.total > ROUTING_LAB_LIMITS.cases || summary.evaluated !== evaluation.cases.length || summary.evaluated > summary.total ||
    summary.expected !== evaluation.cases.filter(item => item.passed !== null).length || summary.passed !== evaluation.cases.filter(item => item.passed === true).length ||
    summary.failed !== evaluation.cases.filter(item => item.passed === false).length || summary.coverage !== (summary.total ? summary.evaluated / summary.total : 0)) return false;
  return true;
}
function validProposal(proposal: RoutingLabPreferenceProposal, state: RoutingLabState): boolean {
  return hasPlainDataKeys(proposal, ['id', 'evaluationId', 'resourceId', 'reason', 'state', 'createdAt', 'withdrawnAt', 'executionAuthorized']) &&
    routingLabId(proposal.id) && hasEligibleRoutingCandidate(state, proposal.evaluationId, proposal.resourceId) &&
    routingLabReference(proposal.resourceId) && companionSafeText(proposal.reason, 1000) && ['proposed', 'withdrawn'].includes(proposal.state) &&
    isCanonicalIsoTimestamp(proposal.createdAt) && (proposal.state === 'proposed' ? proposal.withdrawnAt === null : isCanonicalIsoTimestamp(proposal.withdrawnAt)) && proposal.executionAuthorized === false;
}
function parse(value: unknown): RoutingLabRecord | null {
  try {
    if (!hasPlainDataKeys(value, ['schemaVersion', 'revision', 'previousDigest', 'requestId', 'requestDigest', 'phase', 'subjectId', 'state', 'digest'])) return null;
    const record = value as unknown as RoutingLabRecord; const state = record.state;
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 || !companionToken(record.requestId) ||
      !isSha256Hex(record.requestDigest) || !(record.previousDigest === null || isSha256Hex(record.previousDigest)) ||
      !['intent', 'settled', 'proposal'].includes(record.phase) || !routingLabId(record.subjectId) ||
      !hasPlainDataKeys(state, ['schemaVersion', 'revision', 'evaluations', 'proposals']) || state.schemaVersion !== 1 || state.revision !== record.revision ||
      !Array.isArray(state.evaluations) || state.evaluations.length > ROUTING_LAB_LIMITS.evaluations || !state.evaluations.every(validEvaluation) ||
      new Set(state.evaluations.map(item => item.id)).size !== state.evaluations.length ||
      !Array.isArray(state.proposals) || state.proposals.length > ROUTING_LAB_LIMITS.proposals || !state.proposals.every(proposal => validProposal(proposal, state)) ||
      new Set(state.proposals.map(item => item.id)).size !== state.proposals.length || !isSha256Hex(record.digest)) return null;
    if (record.phase === 'proposal' ? !state.proposals.some(item => item.id === record.subjectId)
      : !state.evaluations.some(item => item.id === record.subjectId && (record.phase === 'intent' ? item.status === 'uncertain' : item.status !== 'uncertain'))) return null;
    const { digest, ...payload } = record;
    return digest === companionDigest(payload) ? record : null;
  } catch { return null; }
}
const codec = createRevisionRecordCodec(parse);
export class RoutingLabStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private config() {
    return createWatermarkedLedgerConfig({ label: 'Offline routing lab', directory: this.directory,
      maxRecordBytes: ROUTING_LAB_LIMITS.recordBytes, maxRecords: ROUTING_LAB_LIMITS.records, maxAggregateBytes: ROUTING_LAB_LIMITS.aggregateBytes, codec });
  }
  read(): { view: RoutingLabView; records: RoutingLabRecord[] } {
    const intents = new Set<string>(); const settled = new Set<string>();
    const ledgerRead = readWatermarkedLedger(this.directory, this.config(), ROUTING_LAB_LIMITS.records, (record, prior, _index, records) => {
      if (record.phase === 'settled') {
        const intent = records.find(item => item.requestId === record.requestId && item.phase === 'intent');
        if (!intent || settled.has(record.requestId) || intent.requestDigest !== record.requestDigest || intent.subjectId !== record.subjectId) return false;
        settled.add(record.requestId);
      } else { if (intents.has(record.requestId)) return false; intents.add(record.requestId); }
      if (prior && prior.state.evaluations.some(evaluation => {
        const next = record.state.evaluations.find(item => item.id === evaluation.id); if (!next) return true;
        if (evaluation.status !== 'uncertain') return canonicalJson(next) !== canonicalJson(evaluation);
        const fixed = (item: RoutingLabEvaluation) => { const { status: _status, completedAt: _at, localDurationMs: _duration,
          cases: _cases, summary: _summary, notes: _notes, ...rest } = item; return rest; };
        return canonicalJson(fixed(next)) !== canonicalJson(fixed(evaluation));
      })) return false;
      if (prior && prior.state.proposals.some(proposal => {
        const next = record.state.proposals.find(item => item.id === proposal.id); if (!next) return true;
        const fixed = (item: RoutingLabPreferenceProposal) => { const { state: _state, withdrawnAt: _at, ...rest } = item; return rest; };
        return canonicalJson(fixed(proposal)) !== canonicalJson(fixed(next)) || proposal.state === 'withdrawn' && canonicalJson(proposal) !== canonicalJson(next);
      })) return false;
      return true;
    });
    const state = ledgerRead.sourceState === 'healthy' ? ledgerRead.records.at(-1)?.state : undefined;
    return state ? { view: { ...structuredClone(state), sourceState: 'healthy', executionAuthorized: false }, records: ledgerRead.records }
      : { view: { schemaVersion: 1, revision: 0, sourceState: ledgerRead.sourceState === 'healthy' ? 'missing' : ledgerRead.sourceState,
          evaluations: [], proposals: [], executionAuthorized: false }, records: [] };
  }
  private replayFromRecords(records: readonly RoutingLabRecord[], command: RoutingLabCommand, requestDigest: string): RoutingLabWrite | null {
    const record = records.find(item => item.requestId === command.requestId);
    if (!record) return null;
    if (record.requestDigest !== requestDigest) return this.fail('conflict');
    // Intent-only interruptions remain uncertain; never invoke the adapter again.
    const latest = records.filter(item => item.requestId === command.requestId).at(-1)!;
    return this.result(latest, 'replayed');
  }
  replay(command: RoutingLabCommand): RoutingLabWrite | null {
    const read = this.read(); if (read.view.sourceState === 'degraded') return this.fail('unavailable');
    return this.replayFromRecords(read.records, command, companionDigest(command));
  }
  fail(reason: 'invalid' | 'conflict' | 'held' | 'unavailable' | 'capacity'): RoutingLabWrite { return { ok: false, reason, executionAuthorized: false }; }
  private result(record: RoutingLabRecord, disposition: 'recorded' | 'replayed'): RoutingLabWrite {
    return { ok: true, disposition, revision: record.revision,
      evaluation: structuredClone(record.state.evaluations.find(item => item.id === record.subjectId) ?? null),
      proposal: structuredClone(record.state.proposals.find(item => item.id === record.subjectId) ?? null), executionAuthorized: false };
  }
  append(command: RoutingLabCommand, phase: RoutingLabRecord['phase'], subjectId: string, mutate: (state: RoutingLabState) => void): RoutingLabWrite {
    return commitWatermarkedLedgerRecord({
      directory: this.directory, lockFileName: '.lab.lock', config: this.config(), maxRecords: ROUTING_LAB_LIMITS.records,
      read: () => { const current = this.read(); return { sourceState: current.view.sourceState, records: current.records }; },
      fail: (reason) => this.fail(reason),
      prepare: (records) => {
        const requestDigest = companionDigest(command); const latest = records.at(-1); const currentRevision = latest?.state.revision ?? 0;
        if (phase !== 'settled') {
          const replay = this.replayFromRecords(records, command, requestDigest); if (replay) return { kind: 'short-circuit', value: replay };
          if (currentRevision !== command.expectedRevision) return { kind: 'short-circuit', value: this.fail('conflict') };
        } else if (!records.some(item => item.requestId === command.requestId && item.phase === 'intent' && item.requestDigest === requestDigest) ||
          records.some(item => item.requestId === command.requestId && item.phase === 'settled')) return { kind: 'short-circuit', value: this.fail('conflict') };
        if (records.length >= ROUTING_LAB_LIMITS.records) return { kind: 'short-circuit', value: this.fail('capacity') };
        const state: RoutingLabState = { schemaVersion: 1, revision: currentRevision, evaluations: structuredClone(latest?.state.evaluations ?? []), proposals: structuredClone(latest?.state.proposals ?? []) };
        try { mutate(state); } catch { return { kind: 'short-circuit', value: this.fail('held') }; } state.revision += 1;
        const payload = { schemaVersion: 1 as const, revision: state.revision, previousDigest: latest?.digest ?? null, requestId: command.requestId, requestDigest, phase, subjectId, state };
        const record = { ...payload, digest: companionDigest(payload) };
        if (!parse(record)) return { kind: 'short-circuit', value: this.fail('invalid') };
        if (Buffer.byteLength(codec.serialize(record)) > ROUTING_LAB_LIMITS.recordBytes) return { kind: 'short-circuit', value: this.fail('capacity') };
        return { kind: 'commit', record };
      },
      onCommitted: (record, disposition) => this.result(record, disposition),
    });
  }
}
