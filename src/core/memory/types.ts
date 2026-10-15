/** Pure memory evidence contracts. IDs/scopes and reviewer labels are caller claims, not authority or truth proofs. */
export const MEMORY_LIMITS = Object.freeze({ events: 4096, snapshotBytes: 32 * 1024 * 1024, textBytes: 16 * 1024,
  quoteBytes: 4096, refs: 8, links: 32, audiences: 32, packBytes: 128 * 1024, packFacts: 64, queryBytes: 4096 });
export interface MemorySourceRef { id: string; digest: string; locator: string; quote: string; observedAt: string | null }
export interface MemoryFactEvent {
  schemaVersion: 1; eventId: string; factId: string; revision: number; kind: 'fact' | 'tombstone';
  projectId: string; ownerId: string; audienceIds: string[]; subjectKey: string; slotKey: string; text: string;
  sourceRefs: MemorySourceRef[]; observedAt: string | null; validFrom: string | null; validUntil: string | null;
  recordedAt: string;
  /** withdrawn is an append-only reviewed revocation revision; validFrom is its effective date. Preserve earlier approved events for historical views. */
  reviewState: 'proposed' | 'approved' | 'disputed' | 'withdrawn'; reviewedAt: string | null;
  reviewerDecisionId: string | null; supersedes: string[]; derivedFrom: string[]; tombstones: string[]; authority: false;
}
export interface MemorySnapshot { schemaVersion: 1; snapshotId: string; revision: number; recordedThrough: string;
  sourceState: 'available' | 'unknown' | 'unavailable'; complete: boolean; events: MemoryFactEvent[]; authority: false }
export type MemoryTime = { mode: 'current' | 'asOf'; at: string };
export interface MemoryPackQuery { schemaVersion: 1; projectId: string; ownerId: string; audienceId: string;
  time: MemoryTime; knownAt: string | null; query: string; maxBytes: number; maxFacts: number; authority: false }
export type MemoryExclusionReason = 'scope' | 'unreviewed' | 'not-recorded' | 'unknown-validity' | 'not-yet-valid' | 'expired'
  | 'tombstone-event' | 'tombstoned' | 'superseded' | 'invalid-lineage' | 'cyclic-lineage' | 'revision-conflict'
  | 'conflict' | 'withdrawn' | 'revoked' | 'dependency-ineligible' | 'irrelevant' | 'byte-budget' | 'fact-budget'
  | 'source-changed' | 'duplicate' | 'weaker-evidence';
export interface MemoryExclusion { eventId: string; reason: MemoryExclusionReason }
export interface MemoryTemporalView { eligible: MemoryFactEvent[]; exclusions: MemoryExclusion[] }
export interface MemoryPackItem { eventId: string; factId: string; revision: number; score: number; sourceRefs: MemorySourceRef[] }
export interface MemoryContextPack {
  schemaVersion: 1; contentSafety: 'screened-with-shared-patterns'; status: 'ready' | 'none' | 'unknown' | 'unavailable' | 'refused'; text: string; bytes: number;
  tokenEstimate: { method: 'utf8-bytes-divided-by-4'; value: number }; items: MemoryPackItem[];
  receipt: { policyVersion: 1; snapshotId: string | null; snapshotRevision: number | null; recordedThrough: string | null;
    scope: { projectId: string; ownerId: string; audienceId: string } | null; time: MemoryTime | null; knownAt: string | null; selectedEventIds: string[];
    /** In-scope exclusions only. Events outside the admitted scope are neither identified nor counted. */
    exclusions: MemoryExclusion[]; stopReasons: string[] };
  authority: false;
}
