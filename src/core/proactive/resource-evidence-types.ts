/** Browser-safe display contracts. These observations never authorize execution or spending. */
/** Funding pools describe balances/allowances; their surface never manufactures an executable API resource. */
export type ProactiveResourceKind = 'native-subscription' | 'api' | 'local' | 'personal-agent' | 'funding-pool';
export type ProactiveEvidenceState = 'current' | 'stale' | 'missing' | 'invalid' | 'conflict';
export interface ProactiveResourceIdentity { provider: string; accountId: string | null; agentId: string | null }
export interface ProactiveResourceUsageWindow {
  id: string; usedPercent: number | null; resetsAt: string | null; resetDescription: string | null;
  limitReached: boolean; observedAt: string | null; evidenceState: ProactiveEvidenceState;
}
export interface ProactiveResourceCredit {
  poolId: string; kind: 'gifted-cloud' | 'purchased-usage' | 'subscription-allowance' | 'native-credit' | 'promotional-api';
  amount: string | null; total: string | null; unit: string; surface: string;
  source: string; asOf: string | null; expiresAt: string | null; expiryDate: string | null;
  expiryState: 'upcoming' | 'expired' | 'unknown'; evidenceState: ProactiveEvidenceState;
  fundingProductId: string | null; fundingAccountId: string | null;
  /** Declared product eligibility never establishes entitlement or account authorization. */
  eligibilityState: 'declared' | 'unknown'; eligibleSurfaces: string[]; excludedSurfaces: string[];
  recordKind: 'balance' | 'purchase' | 'grant';
  /** A purchase/grant receipt is neither remaining balance nor consumed spend. */
  receiptAmount: string | null;
}
export interface ProactiveResourceCost {
  state: 'actual' | 'estimated' | 'unknown'; value: number | null; currency: string | null;
  units: string | null; source: string | null; asOf: string | null; evidenceState: ProactiveEvidenceState;
}
export interface ProactiveResourceEvidenceRow {
  resourceId: string; label: string; identity: ProactiveResourceIdentity; kind: ProactiveResourceKind;
  identityState: 'declared' | 'observed-reference' | 'unknown' | 'conflict';
  connectionState: 'configured' | 'observed' | 'signed-out' | 'unavailable' | 'unknown';
  capabilityState: 'declared-unverified' | 'adapter-reported' | 'unknown'; capabilityIds: string[];
  entitlementState: 'unknown';
  /** Readiness is an observation. It is never execution authorization. */
  readinessState: 'adapter-reported' | 'blocked' | 'unverified' | 'unknown';
  evidenceState: ProactiveEvidenceState; source: string; asOf: string | null;
  usageWindows: ProactiveResourceUsageWindow[]; credits: ProactiveResourceCredit[]; cost: ProactiveResourceCost;
  executionAuthorized: false; notes: string[];
}
export interface ProactiveResourceEvidenceResponse {
  schemaVersion: 1; sampledAt: string; sourceState: 'snapshot' | 'missing' | 'invalid';
  resources: ProactiveResourceEvidenceRow[]; executionAuthorized: false; notes: string[];
}
