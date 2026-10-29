/** Ledger bounds, schemas, and validation constants. */

import type {
  EngineId,
  EngineTier,
  WorkItem,
  DaemonDispatchProductionOutcome,
} from '../../types.js';
import type { DispatchProductionBasis } from './types.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_READ_LIMIT = 2_000;
export const DEFAULT_READ_MAX_FILES = 31;
export const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_READ_MAX_ROWS = 10_000;
export const HARD_READ_MAX_FILES = 32;
export const HARD_READ_MAX_BYTES = 32 * 1024 * 1024;
export const HARD_READ_MAX_ROWS = 50_000;
export const HARD_ATTEMPT_PROOF_TARGETS = 256;
export const MAX_LOOSE_FILES = 3;
export const MAX_DIRECTORY_ENTRIES = 2_048;
export const MAX_READ_ROW_BYTES = 128 * 1024;
export const MAX_ATTEMPT_FUTURE_SKEW_MS = 60_000;
export const ATTEMPT_PROOF_RECEIPT_DIR = 'repair-attempt-proofs';
export const MAX_ATTEMPT_PROOF_RECEIPTS = 2_048;
export const MAX_ATTEMPT_ACTIVE_GENERATIONS = MAX_ATTEMPT_PROOF_RECEIPTS + 1;
export const ATTEMPT_BLOCKED_MEMBERSHIP_BITS = 1_048_576;
export const ATTEMPT_BLOCKED_MEMBERSHIP_BYTES = ATTEMPT_BLOCKED_MEMBERSHIP_BITS / 8;
export const ATTEMPT_BLOCKED_MEMBERSHIP_HASHES = 7;
export const MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS = 4;
export const MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE = 1e-7;
export const MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE =
  MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS * MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE;
export const MAX_ATTEMPT_PROTOCOL_BYTES = 2 * 1024 * 1024;
export const MAX_ATTEMPT_RECEIPT_DIR_ENTRIES = MAX_ATTEMPT_PROOF_RECEIPTS + 16;
export const MAX_STALE_ATTEMPT_RECEIPT_STAGES = 16;
export const MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES =
  MAX_ATTEMPT_RECEIPT_DIR_ENTRIES + MAX_STALE_ATTEMPT_RECEIPT_STAGES;
export const ATTEMPT_RECEIPT_RETENTION_FILE = '.retention.json';
export const MAX_ATTEMPT_RECEIPT_RETENTION_BYTES = 256 * 1024;
export const ATTEMPT_RETENTION_ARTIFACT_SET_DIGEST_DOMAIN =
  'ashlr:dispatch-attempt-retention-artifact-set:v1\0';
export const ATTEMPT_RECEIPT_PROTOCOL_FILE = '.protocol.json';
export const ATTEMPT_RECEIPT_VALIDATION = 'bounded-raw-history-v1';
export const MAX_TREATMENT_OUTCOME_RECEIPTS = 2_048;
export const MAX_TREATMENT_RECEIPT_DIR_ENTRIES = MAX_TREATMENT_OUTCOME_RECEIPTS + 16;
export const TREATMENT_RECEIPT_RETENTION_FILE = '.retention.json';
export const MAX_TREATMENT_RECEIPT_RETENTION_BYTES = 512 * 1024;
export const MAX_TREATMENT_RECEIPT_TOMBSTONES = 2_048;
export const MAX_TREATMENT_RECEIPT_BYTES = 16 * 1024;
export const MAX_TREATMENT_RECEIPT_AGGREGATE_BYTES = 4 * 1024 * 1024;
export const TREATMENT_RECEIPT_PROTOCOL_FILE = '.protocol.json';
export const MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES = 4 * 1024;
export const TREATMENT_RECEIPT_COMPACTED_DIR = '.retired-exact';
export const MAX_TREATMENT_COMPACTED_MARKER_BYTES = 512;
export const MAX_TREATMENT_COMPACTED_MARKERS = HARD_READ_MAX_ROWS;
export const MAX_TREATMENT_COMPACTED_MARKER_AGGREGATE_BYTES = HARD_READ_MAX_BYTES;
export const MAX_ATTEMPT_FAILURE_RECEIPT_BYTES = 16 * 1024;
export const MAX_ATTEMPT_FAILURE_RECEIPT_AGGREGATE_BYTES =
  MAX_ATTEMPT_PROOF_RECEIPTS * MAX_ATTEMPT_FAILURE_RECEIPT_BYTES;
export const TREATMENT_RECEIPT_DIGEST_DOMAIN = 'ashlr:dispatch-treatment-outcome-receipt:v1\0';
export const TREATMENT_RETENTION_DIGEST_DOMAIN = 'ashlr:dispatch-treatment-retention:v1\0';
export const TREATMENT_RETENTION_COMPACTION_DOMAIN = 'ashlr:dispatch-treatment-retention-compaction:v1\0';
export const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const ATTEMPT_RECEIPT_FILE_RE = /^([a-f0-9]{64})-([12])\.json$/;
export const ATTEMPT_RECEIPT_INTENT_FILE_RE = /^([a-f0-9]{64})-([12])\.intent\.json$/;
export const ATTEMPT_FAILURE_RECEIPT_FILE_RE = /^([a-f0-9]{64})-([12])-([a-f0-9]{64})\.failure\.json$/;
export const ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE = /^([a-f0-9]{64})-([12])-([a-f0-9]{64})\.failure\.intent\.json$/;
export const TREATMENT_RECEIPT_FILE_RE = /^([a-f0-9]{64})-([a-f0-9]{64})\.json$/;
export const ATTEMPT_RECEIPT_STAGE_FILE_RE = /^(?:[a-f0-9]{64}-[12](?:-[a-f0-9]{64}\.failure)?\.(?:json|intent\.json)|\.(?:retention|protocol)\.json)(?:\.\d+\.tmp|\.[a-f0-9]{32}\.stage)$/;
export const SHA256_RE = /^[a-f0-9]{64}$/;
export const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'meta-muse', 'grok', 'grok-cli', 'devin-cli',
]);
export const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);
export const WORK_SOURCES = new Set<WorkItem['source']>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint',
  'goal', 'hygiene', 'invent',
]);
export const DISPATCH_PRODUCTION_OUTCOMES = new Set<DaemonDispatchProductionOutcome>([
  'proposal-created', 'cancelled', 'empty-diff', 'gate-blocked', 'engine-failed',
  'sandbox-failed', 'proposal-capture-error', 'proposal-disabled', 'shadow-observation', 'unknown',
]);
export const DISPATCH_PRODUCTION_BASES = new Set<DispatchProductionBasis>([
  'run-proposal-outcome', 'pending-proposal-delta', 'best-of-n-summary',
  'repair-lifecycle-candidate', 'repair-lifecycle-outcome', 'unknown',
]);
export const DISPATCH_PRODUCTION_EVENT_KEYS = new Set([
  'schemaVersion', 'ts', 'machineId', 'itemId', 'source', 'repo', 'title', 'backend',
  'tier', 'model', 'assignedBy', 'routeReason', 'outcome', 'proposalCreated',
  'proposalId', 'attemptId', 'runId', 'trajectoryId', 'routeSnapshot', 'runEventSummary',
  'evidenceOutcome', 'learningSource', 'labelBasis', 'routerPolicyVersion',
  'learningEpoch', 'objectiveHash', 'learningLabel', 'spentUsd', 'diffFiles',
  'diffLines', 'reason', 'basis', 'repairHandoffId', 'repairGenerationId',
  'repairTreatmentUnitId', 'repairTreatment', 'repairTreatmentOutcome',
  'repairTreatmentAttemptHash', 'repairAttemptOrdinal', 'repairPreviousBackend',
  'repairRootId', 'repairDepth', 'repairLineageInvalid',
]);
export const ATTEMPT_RECEIPT_FAILURE_OUTCOMES = new Set<DaemonDispatchProductionOutcome>([
  'engine-failed', 'sandbox-failed', 'proposal-capture-error', 'gate-blocked',
]);
export const MIN_REPAIR_TREATMENT_ATTEMPTS = 3;

export const DISPATCH_PRODUCTION_INVALID_REASON_CODES = [
  'row-too-large',
  'json-invalid',
  'schema-invalid',
  'envelope-mismatch',
  'timestamp-invalid',
  'normalization-failed',
  'receipt-invalid',
] as const;
