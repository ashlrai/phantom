/** Browser-safe qualitative grouping. No value here grants entitlement, execution or spending authority. */
/** Matches routing/headroom's default observation age; current policy may impose a stricter supplied limit. */
export const DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS = 15 * 60_000;
export type ProviderReadingState = 'current' | 'stale' | 'missing' | 'unknown' | 'invalid' | 'conflict' | 'unavailable' | 'declared';
export interface ProviderResourceDescriptor {
  /** accountId is a supplied connection/seat locator or declared Bot reference, never verified human/provider identity. */
  resourceId: string; provider: string; accountId: string | null; label: string; resourceKind: string;
  readingState: ProviderReadingState; observedAt: string | null;
}
export interface ProviderResourceCoverage {
  resources: number; current: number; stale: number; unknown: number;
  /** Distinct verified provider/human accounts cannot be determined from configured references. */
  accounts: null;
  /** Exact provider + supplied ID references only; aliases may name one login and imply no identity/equivalence/ownership. */
  accountReferences: number; unboundResources: number;
  totalExpectedAccounts: null; coverageState: 'unknown';
}
export interface ProviderAccountGroup {
  /** Compatibility name for a configured-reference drilldown bucket, not a verified account or entitlement. */
  accountId: string | null; key: string; resources: ProviderResourceDescriptor[];
  coverage: ProviderResourceCoverage;
}
export interface ProviderResourceGroup {
  /** accounts contains reference buckets; sharing a bucket never establishes pool or account authority. */
  provider: string; resources: ProviderResourceDescriptor[]; accounts: ProviderAccountGroup[];
  coverage: ProviderResourceCoverage; observationIds: string[]; executionAuthorized: false;
}
/** All dimensions are explicit; null is an unknown dimension, never a wildcard. */
export interface ProviderObservationScope {
  /** Measured/funding provider may differ from an execution-view provider; sharing still requires source proof. */
  provider: string; fundingProductId: string | null; fundingAccountId: string | null;
  modelScope: string | null; surface: string; unit: string;
  windowId: string | null; resetsAt: string | null; expiresAt: string | null;
  recordKind: 'usage' | 'balance' | 'purchase' | 'grant' | 'actual-cost' | 'estimated-cost';
}
export interface ProviderScopedObservation {
  observationId: string; resourceId: string; scope: ProviderObservationScope;
  readingState: ProviderReadingState; observedAt: string | null;
  /** Original native quantity. A percent is reported separately and never becomes this numerator. */
  numerator: string | null; denominator: string | null; reportedPercent: number | null;
}
export interface ProviderPoolRelation {
  relationId: string; poolId: string; memberObservationIds: string[];
  /** Complete exact scope, including reset/expiry and product/model/unit dimensions. */
  scope: ProviderObservationScope; observedAt: string; expiresAt: string;
  /** Opaque source reference only. A boolean or display label cannot qualify a relation. */
  proofReference: string;
}
export interface ProviderObservationGroup {
  key: string; relationId: string | null; poolId: string | null; observationIds: string[];
  scope: ProviderObservationScope; state: 'independent' | 'shared-source-qualified' | 'conflict';
  /** Unsupported in this slice, including when percentages have absolute denominators. */
  numericTotal: null; denominator: null;
}
export interface ProviderAggregationResponse {
  schemaVersion: 1; sourceState: 'healthy' | 'invalid'; providers: ProviderResourceGroup[];
  observations: ProviderScopedObservation[]; observationGroups: ProviderObservationGroup[];
  coverage: ProviderResourceCoverage; numericTotal: null; numericTotalState: 'unknown';
  executionAuthorized: false; notes: string[];
}
