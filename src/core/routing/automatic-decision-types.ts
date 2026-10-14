/** Browser-safe descriptive receipts. Caller declarations are not admission or observations. */
import type { AutoMode, PromptKind, PromptSize, SeatAdvice } from '../verse/multimodel/types.js';
import type { VerseContextMode } from '../verse/types.js';
import type { RoutingDifficulty, RoutingTask } from './types.js';

export type AutomaticDecisionPhase = 'plan' | 'replan' | 'execute' | 'review';
export type AutomaticPhaseBasis =
  | { kind: 'prompt-intent'; declaredManagerIntent: null }
  | { kind: 'declared-persisted-manager-intent'; declaredManagerIntent: AutomaticDecisionPhase };
export type AutomaticEligibilitySurface =
  | { kind: 'interactive-chat-advice'; declaredRole: null }
  | { kind: 'declared-host-role'; declaredRole: 'leader' | 'manager' | 'worker' | null };
export type AutomaticClassifierFallbackCode = 'not-provided' | 'not-installed' | 'local-only' | 'empty-input'
  | 'unavailable' | 'below-threshold' | 'invalid-response';
export interface AutomaticCorrelationRefs {
  sourceRef: string | null;
  policyRef: string | null;
  rosterRef: string | null;
  sessionRef: string | null;
  preferenceRef: string | null;
  basisRef: string | null;
}
export interface AutomaticDecisionReceiptInput {
  baseline: SeatAdvice;
  phase: AutomaticDecisionPhase;
  phaseBasis: AutomaticPhaseBasis;
  eligibilitySurface: AutomaticEligibilitySurface;
  observedAtMs: number;
  refs?: Partial<AutomaticCorrelationRefs>;
  classifierFallbackCode?: AutomaticClassifierFallbackCode;
}
export interface AutomaticRecommendedBinding {
  seatId: string | null;
  engine: string | null;
  model: string | null;
  contextMode: VerseContextMode | null;
  contextWindow: number | null;
}
export interface AutomaticUnknownEvidence {
  state: 'unknown';
  value: null;
}
export interface AutomaticUnknownMetric extends AutomaticUnknownEvidence {
  code: 'not-qualified-by-receipt';
}
export interface AutomaticDecisionReceiptV1 {
  schemaVersion: 1;
  scope: 'automatic-decision-receipt';
  executionAuthorized: false;
  status: 'recommendation' | 'advisory-held';
  recommendedBinding: AutomaticRecommendedBinding | null;
  alternatives: AutomaticRecommendedBinding[];
  baseline: { mode: AutoMode | null; stay: boolean; localOnly: boolean };
  held: { code: 'baseline-held'; message: 'No baseline recommendation is available.' } | null;
  exclusions: Array<{ seatId: string | null; code: 'baseline-excluded' }>;
  intent: {
    phase: AutomaticDecisionPhase | null;
    phaseBasis: AutomaticPhaseBasis | { kind: 'unknown'; declaredManagerIntent: null };
    eligibilitySurface: AutomaticEligibilitySurface | { kind: 'unknown'; declaredRole: null };
    provenance: 'caller-declared';
  };
  correlation: { provenance: 'caller-declared'; observedAtMs: number | null; refs: AutomaticCorrelationRefs };
  classification: {
    scope: 'task-triage-only';
    kind: PromptKind | null;
    task: RoutingTask | null;
    difficulty: RoutingDifficulty | null;
    size: PromptSize | null;
    estTokens: number | null;
    decidedBy: 'rules' | 'jev' | 'unknown';
    confidence: number | null;
    needsFrontier: number | null;
    fallbackCode: AutomaticClassifierFallbackCode;
  };
  returnedSessionBinding: AutomaticUnknownEvidence;
  providerObservedBinding: AutomaticUnknownEvidence;
  verifiedOutcome: AutomaticUnknownEvidence;
  metrics: { quality: AutomaticUnknownMetric; executionDurationMs: AutomaticUnknownMetric; realizedCostUsd: AutomaticUnknownMetric };
}
