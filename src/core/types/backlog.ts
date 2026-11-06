/** Shared backlog contracts. Public entry point: ../types.ts. */
import type { EngineId, EngineTier } from './engines.js';

/**
 * M22: WORK DISCOVERY - `ashlr backlog`.
 * A scored, prioritized work queue derived READ-ONLY across ENROLLED repos.
 */

/** The kind of source a WorkItem was derived from. */
export type WorkSource = 'issue' | 'todo' | 'test' | 'dep' | 'doc' | 'security' | 'plugin' | 'self' | 'lint' | 'goal' | 'hygiene' | 'invent'; // M33: 'plugin'; M54: 'self' (the fleet's own backlog); M101: 'lint' (cached lint report); M160/M161: 'goal' (active goal next-step), 'hygiene' (low-value hygiene) - all additive; M181: 'invent' (generative engine - bold net-new features)

/** Fixed metadata-only instruction treatment for trusted diagnostic no-diff reslices. */
export type RepairTreatment = 'baseline-reslice' | 'target-localization';
/** Bounded generated-repair ancestry. A root repair is depth 0; its only child is depth 1. */
export type RepairDepth = 0 | 1;
/**
 * A single discovered, scored unit of work. Produced by a scanner over a
 * single enrolled repo. Contains NO secrets. Pure analysis - never implies a
 * mutation was performed.
 */
export interface WorkItem {
  /** Stable, deterministic id (e.g. `${repo}:${source}:${hash}`). */
  id: string;
  /** Absolute path of the enrolled repo this item belongs to. */
  repo: string;
  /** Which scanner produced this item. */
  source: WorkSource;
  /** Short, human-readable title. */
  title: string;
  /** Longer detail / context (no secrets). */
  detail: string;
  /** Estimated value of doing the work, 1 (low) .. 5 (high). */
  value: number;
  /** Estimated effort to do the work, 1 (low) .. 5 (high). */
  effort: number;
  /** Priority score; higher = do first. score = scoreItem(value, effort). */
  score: number;
  /** Free-form tags (e.g. ['security','npm-audit']). */
  tags: string[];
  /** ISO timestamp this item was generated. */
  ts: string;
  /** Stable metadata-only identity shared by every repair descendant for one original objective. */
  repairRootId?: string;
  /** Canonical producer/parent authority input from which repairRootId is derived. */
  repairRootAuthorityId?: string;
  /** Explicit bounded ancestry within repairRootId. Rootless or deeper rows cannot dispatch autonomously. */
  repairDepth?: RepairDepth;
  /** Durable parent-handoff observation that authorizes this generated repair projection. */
  repairHandoffId?: string;
  /** Stable generation identity derived from authoritative parent control identity. */
  repairGenerationId?: string;
  /** Canonical objective-scoped treatment unit shared by V1/V2 handoff aliases. */
  repairTreatmentUnitId?: string;
  /** Deterministic instruction treatment; never changes routing or authority. */
  repairTreatment?: RepairTreatment;
  /** Original work item retried by this generated repair. */
  repairParentItemId?: string;
  /** Original scanner source. The generated child remains source=self for control-plane trust. */
  repairParentSource?: WorkSource;
  /** Backend used by the parent attempt, when durably observed. */
  repairParentBackend?: EngineId | null;
  /** Engine tier used by the parent attempt, when durably observed. */
  repairParentTier?: EngineTier | null;
  /** Scrubbed metadata-only hash binding a repair generation to parent meaning. */
  repairParentObjectiveHash?: string;
}

/** Metadata-only scanner evidence. Observations never grant lifecycle authority. */
export type ScannerObservationStatus = 'present' | 'absent' | 'unavailable';

/** Fixed, bounded reason vocabulary for scanner observations. */
export type ScannerObservationReason =
  | 'item-observed'
  | 'source-confirmed-empty'
  | 'legacy-empty-result'
  | 'scanner-failed'
  | 'source-unavailable'
  | 'source-unreadable'
  | 'source-malformed'
  | 'source-unsafe'
  | 'source-raced'
  | 'source-dirty'
  | 'source-snapshot-unavailable'
  | 'config-unavailable'
  | 'scanner-revision-unknown'
  | 'objective-hash-unavailable';

/** The complete source view used by a revisioned scanner observation. */
export type SourceBaseKind =
  | 'git-tree'
  | 'filesystem-snapshot'
  | 'local-store'
  | 'remote-snapshot';

/** How the scanner obtained one internally consistent source view. */
export type SourceBaseConsistency = 'immutable' | 'locked' | 'stable-double-read';

/** Worktree dirtiness observed while constructing a source base. */
export type SourceBaseDirtyState =
  | 'clean'
  | 'tracked'
  | 'untracked'
  | 'mixed'
  | 'not-applicable';

/**
 * Metadata-only identity for the exact source and config read by a scanner.
 * The source/config values themselves are never retained in this envelope.
 */
export interface SourceBaseDigestV1 {
  schemaVersion: 1;
  algorithm: 'hmac-sha256';
  sourceKind: SourceBaseKind;
  sourceDigest: string;
  /** Invariant objective prerequisites, separate from the exact changing source state. */
  requirementDigest: string;
  configDigest: string;
  baseDigest: string;
  scannerRevision: number;
  consistency: SourceBaseConsistency;
  dirty: SourceBaseDirtyState;
}

/** Static scanner metadata used to interpret an observation conservatively. */
export interface ScannerDescriptor {
  /** Stable scanner identifier; not a work-item or lifecycle identifier. */
  id: string;
  /** Semantic discovery revision; absent on legacy descriptors. */
  scannerRevision?: number;
  /** Metadata-only discovery domain, such as github or local-queue. */
  domain: string;
  /** Primary source emitted by the scanner. Present observations use the item's exact source. */
  source: WorkSource;
  /** Short operator-facing description of what the scanner reads. */
  description: string;
  /** Legacy scanners cannot distinguish empty from degraded discovery. */
  evidence: 'legacy' | 'exhaustive';
  /** Explicit absence capability. False for every legacy scanner. */
  canAssertAbsent: boolean;
  /** Maximum work items accepted from one invocation. */
  maxItems: number;
}

/**
 * Bounded metadata-only evidence from one scanner invocation.
 * Present observations are bound to an exact item id and host-local objective
 * hash. Absent/unavailable observations intentionally carry neither.
 */
export interface ScannerObservation {
  schemaVersion: 1;
  observedAt: string;
  repo: string;
  scannerId: string;
  domain: string;
  source: WorkSource;
  status: ScannerObservationStatus;
  reason: ScannerObservationReason;
  itemId?: string;
  objectiveHash?: string;
  /** Exact metadata-only source/config base; absent for unavailable observations. */
  sourceBase?: SourceBaseDigestV1;
  /** Host-local attestation binding this observation to its authenticated source base. */
  observationDigest?: string;
}

/**
 * The aggregated, persisted backlog. Written to ~/.ashlr/backlog.json by
 * buildBacklog(). Covers only ENROLLED repos (DEFAULT EMPTY => empty items).
 */
export interface Backlog {
  /** ISO timestamp the backlog was generated. */
  generatedAt: string;
  /** Random identity for this exact persisted generation; absent on legacy snapshots. */
  snapshotId?: string;
  /** Absolute paths of the repos that were scanned. */
  repos: string[];
  /** All discovered work items, deduped and scored. */
  items: WorkItem[];
  /** Optional metadata-only scanner evidence; absent on legacy backlog files. */
  observations?: ScannerObservation[];
  /** Integrity/completeness of the persisted observation envelope. */
  observationSourceState?: 'healthy' | 'degraded';
  /** True when bounded persistence omitted observation rows. */
  observationsTruncated?: boolean;
}
