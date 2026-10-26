/** A provider-neutral reference. Display labels never confer account authority. */
export interface CompanionPacketDestination { provider: string; accountId: string; agentId: string }
export interface CompanionPacketArtifact {
  repo?: string; expectedHeadSha?: string; artifactRef?: string; revision?: string;
}
/** Matches temporal task-context provenance; excerpts are bounded, optional projections. */
export interface CompanionPacketEvidence {
  source: { provider: string; accountRef: string; objectRef: string; revisionRef: string };
  observedAt: string; epistemic: 'recorded' | 'derived' | 'hypothesis'; excerpt?: string;
}
/** A context packet is evidence and a work brief, never a provider admission or grant. */
export interface CompanionPacketV1 {
  schemaVersion: 1;
  projectBindingId: string; tenantId: string; taskId: string;
  goal: string; acceptance: string[]; accountRefs: string[];
  allowedDestination: CompanionPacketDestination;
  artifact: CompanionPacketArtifact;
  evidence: CompanionPacketEvidence[];
  asOf: string;
  coverage: { sourceState: 'missing' | 'healthy' | 'degraded'; complete: boolean; stopReasons: string[] };
  deadline: string | null;
  /** Null means unknown/not supplied; zero is an explicit zero-dollar ceiling. */
  limits: { maxCostUsd: number | null; maxAttempts: number; maxContextBytes: number };
}
export type CompanionPacketInput = Omit<CompanionPacketV1, 'schemaVersion'>;
/** Host-only authorization, supplied separately from packet JSON. Every source account
 * must be explicitly included, including the destination's own account if it is a source.
 * stillAuthorized additionally checks object scope, grant revision/revocation and policy.
 * Recheck again at actual contact/publication; building a packet does not authorize IO. */
export interface CompanionPacketAuthorization {
  projectBindingId: string; tenantId: string; taskId: string;
  accountRefs: readonly string[]; allowedDestination: CompanionPacketDestination;
  stillAuthorized: (packet: Readonly<CompanionPacketV1>) => boolean;
}
export interface CompanionPacketFreshness {
  asOf: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  staleEvidenceIndexes: number[];
  futureEvidenceIndexes: number[];
  partial: boolean;
  sourceState: CompanionPacketV1['coverage']['sourceState'];
  stopReasons: string[];
  deadlineExceeded: boolean;
}
