/** Local companion coordination evidence. No record authorizes provider contact. */
import { createHash } from 'node:crypto';
import type { ProactiveIdentity } from './types.js';

export type CompanionIdentity = ProactiveIdentity;
export type CompanionTaskState = 'draft' | 'assigned' | 'handoff-intent' | 'cancel-requested' | 'reported' | 'verified' | 'needs-attention';
export type CompanionContactState = 'not-contacted' | 'intent' | 'accepted' | 'unknown' | 'proved-unstarted' | 'cancel-confirmed';
export interface CompanionAttempt {
  id: string; epoch: number; assignee: CompanionIdentity; ownerId: string;
  claimedAt: string; leaseExpiresAt: string; packetDigest: string;
  contact: CompanionContactState; handoffAt: string | null; cancelRequestedAt: string | null;
  providerRunId: string | null; observationReference: string | null;
}
export interface CompanionReport {
  id: string; attemptId: string; epoch: number; packetDigest: string;
  producer: CompanionIdentity; result: string; resultDigest: string; report: string; reportDigest: string;
  source: 'manual-unverified'; sourceReference: string; submittedAt: string; stale: boolean;
}
export type CompanionReviewer = { kind: 'peer'; identity: CompanionIdentity } | { kind: 'operator'; operatorId: string };
export interface CompanionVerification {
  id: string; reportId: string; checkedResultDigest: string; reviewer: CompanionReviewer;
  acceptanceMet: boolean; applied: boolean; source: 'manual-operator-review'; at: string;
}
export interface CompanionEvent {
  seq: number; commandId: string; type: string; at: string;
  attemptId: string | null; reportId: string | null; source: 'local-manual' | 'host-observed';
}
export interface CompanionNotification {
  eventId: string; state: 'pending' | 'acknowledged'; reason: 'needs-review' | 'verified' | 'needs-attention' | 'cancel-requested'; at: string;
}
export interface CompanionTaskInput {
  tenantId: string; projectBindingId: string; taskKey: string; goal: string; acceptance: string[];
  packetDigest: string; capabilityIds: string[];
  /** Planning limits only: no provider quota or spend authority is established. */
  deadline?: string | null; maxCostUsd?: number | null; maxAttempts?: number;
}
export interface CompanionTask extends CompanionTaskInput {
  deadline: string | null; maxCostUsd: number | null; maxAttempts: number;
  id: string; createdAt: string; updatedAt: string; state: CompanionTaskState;
  attempts: CompanionAttempt[]; reports: CompanionReport[]; verifications: CompanionVerification[];
  events: CompanionEvent[]; notification: CompanionNotification | null;
}
export interface CompanionLedger { schemaVersion: 1; revision: number; tasks: Record<string, CompanionTask> }
export interface CompanionRecord {
  schemaVersion: 1; revision: number; previousDigest: string | null; commandId: string;
  requestDigest: string; taskId: string; state: CompanionLedger; digest: string;
}
export interface CompanionCommandBase { commandId: string; expectedRevision: number }
export type CompanionCommand = CompanionCommandBase & (
  | { kind: 'create'; task: CompanionTaskInput }
  | { kind: 'assign'; taskId: string; assignee: CompanionIdentity; ownerId: string; leaseMs: number }
  | { kind: 'handoff'; taskId: string; attemptId: string; epoch: number; ownerId: string }
  | { kind: 'report'; taskId: string; attemptId: string; epoch: number; packetDigest: string; result: string; report: string; sourceReference: string }
  | { kind: 'operator-review'; taskId: string; reportId: string; checkedResultDigest: string; reviewer: CompanionReviewer; acceptanceMet: boolean }
  | { kind: 'cancel'; taskId: string; attemptId: string }
  | { kind: 'notification-ack'; taskId: string; eventId: string }
);
export type CompanionFailure = 'invalid' | 'conflict' | 'held' | 'not-found' | 'unavailable' | 'capacity';
export type CompanionWrite =
  | { ok: true; disposition: 'recorded' | 'replayed'; revision: number; taskId: string; task: CompanionTask; dispatchAuthorized: false }
  | { ok: false; reason: CompanionFailure; dispatchAuthorized: false };
export interface CompanionList {
  sourceState: 'healthy' | 'missing' | 'degraded'; revision: number; tasks: CompanionTask[];
}
export interface CompanionRead {
  sourceState: 'healthy' | 'missing' | 'degraded'; revision: number; task: CompanionTask | null;
}
/** Injected host evidence port; never populated from a local HTTP/JSON command. */
export interface CompanionHostObservation {
  taskId: string; attemptId: string; epoch: number; assignee: CompanionIdentity; packetDigest: string;
  state: 'accepted' | 'unknown' | 'proved-unstarted' | 'cancel-confirmed';
  providerRunId: string | null; evidenceReference: string;
}
export interface CompanionHostHooks {
  observe(task: Readonly<CompanionTask>, attempt: Readonly<CompanionAttempt>): CompanionHostObservation | null;
}
export interface CompanionCoordinator {
  list(filter?: { tenantId?: string; projectBindingId?: string }): CompanionList;
  read(taskId: string): CompanionRead;
  /** Read-only exact-command receipt lookup before caller-side live prechecks. */
  replay(command: CompanionCommand): CompanionWrite | null;
  execute(command: CompanionCommand): CompanionWrite;
  reconcile(commandId: string, expectedRevision: number, taskId: string, attemptId: string): CompanionWrite;
}
export const COMPANION_LIMITS = Object.freeze({ tasks: 64, attempts: 32, reports: 64, verifications: 128, events: 512,
  goalBytes: 8000, resultBytes: 16000, reportBytes: 8000, recordBytes: 1024 * 1024, records: 2048,
  ledgerBytes: 64 * 1024 * 1024, leaseMaxMs: 24 * 60 * 60 * 1000 });
export function companionCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(companionCanonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${companionCanonical(item)}`).join(',')}}`;
}
export function companionDigest(value: unknown): string { return createHash('sha256').update(companionCanonical(value)).digest('hex'); }
export function companionTextDigest(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function companionTaskId(input: Pick<CompanionTaskInput, 'tenantId' | 'projectBindingId' | 'taskKey'>): string {
  return `ct_${companionDigest([input.tenantId, input.projectBindingId, input.taskKey]).slice(0, 32)}`;
}
export function companionIdentityEqual(left: CompanionIdentity, right: CompanionIdentity): boolean {
  return left.provider === right.provider && left.accountId === right.accountId && left.agentId === right.agentId;
}
