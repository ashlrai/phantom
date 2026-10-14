/** Pure, pre-dispatch description of an existing baseline. No ranking or authorization. */
import type { AutomaticDecisionReceiptInput, AutomaticDecisionReceiptV1, AutomaticRecommendedBinding,
  AutomaticUnknownEvidence, AutomaticUnknownMetric } from './automatic-decision-types.js';

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function probability(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && number <= 1 ? number : null;
}
function ref(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) ? value : null;
}
function binding(option: NonNullable<AutomaticDecisionReceiptInput['baseline']['choice']>): AutomaticRecommendedBinding {
  return {
    seatId: text(option.seatId), engine: text(option.engine), model: text(option.model),
    contextMode: enumValue(option.contextMode, ['standard', 'expansive']),
    contextWindow: nonnegative(option.contextWindow),
  };
}
function unknownEvidence(): AutomaticUnknownEvidence {
  return { state: 'unknown', value: null };
}
function unknownMetric(): AutomaticUnknownMetric {
  return { state: 'unknown', value: null, code: 'not-qualified-by-receipt' };
}

/** Typed, in-memory advice projection, not an HTTP parser or host attestation.
 * Only explicit fields are read; prose, extra claims and metrics are never copied.
 * Missing historical mode/window stay unknown, without alias/default resolution. */
export function composeAutomaticDecisionReceipt(input: AutomaticDecisionReceiptInput): AutomaticDecisionReceiptV1 {
  const base = input.baseline;
  const cls = base.classification;
  const phase = enumValue(input.phase, ['plan', 'replan', 'execute', 'review']);
  const managerIntent = enumValue(input.phaseBasis.declaredManagerIntent, ['plan', 'replan', 'execute', 'review']);
  const role = enumValue(input.eligibilitySurface.declaredRole, ['leader', 'manager', 'worker']);
  return {
    schemaVersion: 1, scope: 'automatic-decision-receipt', executionAuthorized: false,
    status: base.choice === null ? 'advisory-held' : 'recommendation',
    recommendedBinding: base.choice === null ? null : binding(base.choice),
    alternatives: base.alternatives.map(binding),
    baseline: { mode: enumValue(base.mode, ['auto', 'cheap-first']), stay: base.stay === true, localOnly: base.localOnly.on === true },
    held: base.choice === null ? { code: 'baseline-held', message: 'No baseline recommendation is available.' } : null,
    exclusions: base.held.map(row => ({ seatId: text(row.seatId), code: 'baseline-excluded' })),
    intent: {
      phase,
      phaseBasis: input.phaseBasis.kind === 'prompt-intent' ? { kind: 'prompt-intent', declaredManagerIntent: null }
        : input.phaseBasis.kind === 'declared-persisted-manager-intent' && managerIntent !== null
          ? { kind: 'declared-persisted-manager-intent', declaredManagerIntent: managerIntent }
          : { kind: 'unknown', declaredManagerIntent: null },
      eligibilitySurface: input.eligibilitySurface.kind === 'interactive-chat-advice'
        ? { kind: 'interactive-chat-advice', declaredRole: null }
        : input.eligibilitySurface.kind === 'declared-host-role' ? { kind: 'declared-host-role', declaredRole: role }
          : { kind: 'unknown', declaredRole: null },
      provenance: 'caller-declared',
    },
    correlation: {
      provenance: 'caller-declared', observedAtMs: nonnegative(input.observedAtMs),
      refs: { sourceRef: ref(input.refs?.sourceRef), policyRef: ref(input.refs?.policyRef), rosterRef: ref(input.refs?.rosterRef),
        sessionRef: ref(input.refs?.sessionRef), preferenceRef: ref(input.refs?.preferenceRef), basisRef: ref(input.refs?.basisRef) },
    },
    classification: {
      scope: 'task-triage-only',
      kind: enumValue(cls.kind, ['question', 'explain', 'code', 'debug', 'refactor', 'review', 'plan', 'bulk']),
      task: enumValue(cls.task, ['code', 'review', 'plan', 'bulk', 'leader']),
      difficulty: enumValue(cls.difficulty, ['low', 'medium', 'high']), size: enumValue(cls.size, ['small', 'medium', 'large']),
      estTokens: nonnegative(cls.estTokens), decidedBy: cls.decidedBy === undefined ? 'rules' : enumValue(cls.decidedBy, ['rules', 'jev']) ?? 'unknown',
      confidence: probability(cls.confidence), needsFrontier: probability(cls.needsFrontier),
      fallbackCode: enumValue(input.classifierFallbackCode, ['not-provided', 'not-installed', 'local-only', 'empty-input',
        'unavailable', 'below-threshold', 'invalid-response']) ?? 'not-provided',
    },
    returnedSessionBinding: unknownEvidence(), providerObservedBinding: unknownEvidence(), verifiedOutcome: unknownEvidence(),
    metrics: { quality: unknownMetric(), executionDurationMs: unknownMetric(), realizedCostUsd: unknownMetric() },
  };
}
