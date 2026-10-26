/** Browser-safe offline planning DTOs. A routing receipt never grants execution. */
import type { ProactiveResourceEvidenceResponse } from './resource-evidence-types.js';
import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';

export interface RoutingLabTask {
  taskId: string; tenantId: string; projectBindingId: string; packetDigest: string;
  capabilityIds: string[]; accountRefs: string[]; deadline: string | null; maxCostUsd: number | null;
  /** Exact planned recipient, separately bound from source-account evidence refs. */
  allowedDestination?: { provider: string; accountId: string; agentId: string };
}
export interface RoutingLabCandidate {
  resourceId: string; label: string; qualification: 'planning-candidate' | 'qualified-shadow-fixture' | 'held';
  holds: string[]; matchedCapabilityIds: string[]; sourceMode: 'fixture' | 'shadow-readonly'; executionAuthorized: false;
}
export interface RoutingLabCaseReceipt {
  caseId: string; taskDigest: string; snapshotDigest: string; candidates: RoutingLabCandidate[];
  selectedResourceId: string | null; path: 'deterministic' | 'fixture-advice' | 'held' | 'aborted';
  fallbackReason: string | null; expectedResourceId: string | null; passed: boolean | null; notes: string[];
  localDurationMs: number; providerLatencyMs: null; executionAuthorized: false;
}
export interface RoutingLabEvaluation {
  id: string; requestId: string; kind: 'preview' | 'benchmark'; mode: 'fixture' | 'shadow-readonly';
  status: 'uncertain' | 'completed' | 'aborted'; inputDigest: string; snapshotDigest: string;
  policyId: 'companion-routing-lab-v1'; modelId: 'jev-1.13.0'; adapterMode: 'deterministic-only' | 'offline-fixture';
  createdAt: string; completedAt: string | null; localDurationMs: number | null; providerLatencyMs: null;
  cases: RoutingLabCaseReceipt[];
  summary: { total: number; evaluated: number; expected: number; passed: number; failed: number; coverage: number };
  executionAuthorized: false; notes: string[];
}
export interface RoutingLabPreferenceProposal {
  id: string; evaluationId: string; resourceId: string; reason: string; state: 'proposed' | 'withdrawn';
  createdAt: string; withdrawnAt: string | null; executionAuthorized: false;
}
export type RoutingLabCommand = { requestId: string; expectedRevision: number } & (
  | { kind: 'preview'; task: RoutingLabTask }
  | { kind: 'preview'; taskId: string }
  | { kind: 'benchmark' }
  | { kind: 'propose-preference'; evaluationId: string; resourceId: string; reason: string }
  | { kind: 'withdraw-preference'; proposalId: string }
);
export interface RoutingLabState { schemaVersion: 1; revision: number; evaluations: RoutingLabEvaluation[]; proposals: RoutingLabPreferenceProposal[] }
export interface RoutingLabView extends RoutingLabState { sourceState: 'healthy' | 'missing' | 'degraded'; executionAuthorized: false }
export type RoutingLabWrite =
  | { ok: true; disposition: 'recorded' | 'replayed'; revision: number; evaluation: RoutingLabEvaluation | null;
      proposal: RoutingLabPreferenceProposal | null; executionAuthorized: false }
  | { ok: false; reason: 'invalid' | 'conflict' | 'held' | 'unavailable' | 'capacity'; executionAuthorized: false };
export interface RoutingLabRecord {
  schemaVersion: 1; revision: number; previousDigest: string | null; requestId: string; requestDigest: string;
  phase: 'intent' | 'settled' | 'proposal'; subjectId: string; state: RoutingLabState; digest: string;
}
/** Ordinals and synthetic metadata only; never actual snapshot rows or account identities. */
export interface OfflineChoicePayload {
  model: 'jev-1.13.0'; mode: 'offline-fixture'; state: string;
  questions: { resource_choice: TypeSafeChoiceQuestion };
}
export type OfflineChoiceResponse =
  | { ok: true; answers: { resource_choice: { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } } }
  | { ok: false; reason: 'timeout' | '429' | '529' | 'malformed-response' };
export interface OfflineChoiceAdapter {
  mode: 'offline-fixture'; choose(payload: OfflineChoicePayload, signal: AbortSignal): Promise<unknown>;
}
export interface RoutingLab {
  list(): RoutingLabView;
  replay(command: RoutingLabCommand): RoutingLabWrite | null;
  execute(command: RoutingLabCommand, options?: { signal?: AbortSignal; timeBudgetMs?: number }): Promise<RoutingLabWrite>;
}
export interface RoutingLabOptions {
  directory?: string; now?: () => Date;
  /** Read-only projection supplied by the host; no connector or credential reads in the lab. */
  resources?: () => ProactiveResourceEvidenceResponse; adapter?: OfflineChoiceAdapter;
  resolveTask?: (taskId: string) => RoutingLabTask | null;
}
