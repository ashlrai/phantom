/** Display suggestions only; providers are extensible stable slugs, not a closed registry. */
export const PROACTIVE_PROVIDERS = ['openai-dot', 'grok-bot', 'meta-muse', 'other'] as const;
export type ProactiveProvider = string;
export interface ProactiveIdentity { provider: ProactiveProvider; accountId: string; agentId: string }
export interface ProactiveAvatar { color: string; variant: 'classic' | 'round' | 'pixel' }
export interface ProactiveComputer { kind: 'hosted' | 'connected-local' | 'unknown'; label: string; providerComputerId: string | null }
export interface ProactiveService { id: string; label: string }
/** A reference only: no balance, expiry, credential or spending permission is inferred. */
export interface ProactiveFundingReference { kind: 'subscription' | 'promotional-api' | 'unknown'; accountId: string; poolId: string | null }
/** Declared planning preferences never grant project access, transport or spending authority. */
export interface ProactivePreferences {
  priority: number; maxConcurrent: number;
  /** Empty means no declared preference restriction; actual authorization is always checked separately. */
  projectBindingIds: string[];
}
export type ProactiveOperation = 'dispatch' | 'status' | 'cancel' | 'result';
export interface ProactiveOperationReadiness {
  state: 'unverified' | 'unsupported'; verifiedAt: null; note: string;
}
/** Acceptance, provider completion and independently verified outcome are different observations. */
export type ProactiveRunState = 'accepted' | 'running' | 'completed' | 'result-verified' | 'failed' | 'unknown';
export interface ProactiveRunObservation {
  id: string; requestId: string; state: ProactiveRunState; providerRunId: string | null;
  observedAt: string; sourceReference: string; resultReference: string | null;
}
export interface ProactiveProfileInput {
  identity: ProactiveIdentity; displayName: string; avatar?: ProactiveAvatar; responsibility?: string;
  computer?: ProactiveComputer; services?: ProactiveService[]; fundingReference?: ProactiveFundingReference | null;
  capabilityIds?: string[]; preferences?: Partial<ProactivePreferences>;
  /** Used by local assignment previews; never enables transport or autonomous dispatch. */
  enabled?: boolean;
}
export type ProactiveProfilePatch = Partial<Omit<ProactiveProfileInput, 'identity'>> & { expectedVersion: number };
export interface ProactiveProfile {
  id: string; version: number; identity: ProactiveIdentity; displayName: string; avatar: ProactiveAvatar;
  responsibility: string; computer: ProactiveComputer; services: ProactiveService[];
  capabilityIds: string[]; capabilityVerification: 'declared-unverified'; preferences: ProactivePreferences;
  fundingReference: ProactiveFundingReference | null; enabled: boolean; connection: 'configured';
  operations: Record<ProactiveOperation, ProactiveOperationReadiness>;
  /** No qualified adapter supplies run evidence in this implementation. */
  lastRun: null; createdAt: string; updatedAt: string;
}
export interface ProactiveProfilesResponse { schemaVersion: 1; profiles: ProactiveProfile[] }
export const VERSE_PROACTIVE_AGENTS_PATH = '/api/verse/proactive-agents';
