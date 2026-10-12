/** Browser-safe release planning projections. No value in this contract grants an effect. */
export type ReleaseChannel = 'npm' | 'website' | 'desktop';
export interface ReleaseBinding {
  channel: ReleaseChannel;
  targetId: string;
  version: string;
  sourceRevision: string;
  artifactDigest: string;
  /** Exact planning attempt; a new attempt does not reconcile an old provider write. */
  attemptId: string;
}
export type ReleaseEvidenceKind = 'tests' | 'qualification' | 'provenance' | 'commissioning' | 'provider-status' | 'replay';
export type ReleaseEvidenceSource = 'local-readonly' | 'host-observed' | 'fixture' | 'declared';
export interface ReleaseEvidenceReceipt {
  id: string;
  kind: ReleaseEvidenceKind;
  binding: ReleaseBinding;
  source: ReleaseEvidenceSource;
  status: 'passed' | 'failed' | 'unknown' | 'revoked';
  observedAt: string;
  expiresAt: string;
  reference: string;
  /** Provider state and replay disposition are observations, never permissions. */
  providerState?: 'not-contacted' | 'available' | 'published' | 'installed' | 'unknown' | 'failed';
  replayState?: 'unconsumed' | 'consumed' | 'unknown';
  scopeRevision?: string;
}
export interface ReleasePostCheckPlan {
  binding: ReleaseBinding;
  checks: string[];
  deadlineAt: string;
  ownerId: string;
}
export type ReleaseRecoveryPlan =
  | { channel: 'npm'; binding: ReleaseBinding; strategy: 'corrective-version' | 'deprecate-and-correct';
      correctiveVersion: string; overwritePublishedVersion: false; ownerId: string }
  | { channel: 'website'; binding: ReleaseBinding; strategy: 'restore-deployment';
      previousDeploymentId: string; affectedTargets: string[]; ownerId: string }
  | { channel: 'desktop'; binding: ReleaseBinding; strategy: 'signed-recovery-update';
      previousSignedInstallerDigest: string; updateChannel: string; customerUpdatePath: string;
      compatibilityChecks: string[]; ownerId: string };
export interface ReleaseReadinessInput {
  binding: ReleaseBinding;
  asOf: string;
  sourceClean: boolean | null;
  evidence: ReleaseEvidenceReceipt[];
  postChecks: ReleasePostCheckPlan | null;
  recovery: ReleaseRecoveryPlan | null;
}
/** Injected by the host from independently verified read-only receipts, never JSON/body input.
 * A successful check is evidence only. Actual release consumers retain their own current gates. */
export interface ReleaseReadinessHost {
  verifyEvidence(receipt: Readonly<ReleaseEvidenceReceipt>, binding: Readonly<ReleaseBinding>, asOf: string):
    'verified' | 'invalid' | 'unavailable' | 'revoked';
}
export type ReleaseReadinessGateState = 'passed' | 'blocked' | 'unknown' | 'simulated';
export interface ReleaseReadinessGate {
  id: string;
  state: ReleaseReadinessGateState;
  reason: string;
  receiptIds: string[];
}
export interface ReleaseReadinessResult {
  schemaVersion: 1;
  binding: ReleaseBinding;
  asOf: string;
  readiness: 'ready-for-review' | 'blocked' | 'unknown';
  /** Simulated evidence can never be presented as a live release qualification. */
  simulated: boolean;
  evidenceLayer: 'source' | 'published' | 'installed' | 'simulated';
  gates: ReleaseReadinessGate[];
  gaps: string[];
  releaseAuthorized: false;
  effects: { publish: false; deploy: false; install: false; serviceMutation: false; permissionChange: false };
}
