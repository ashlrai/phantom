/** Fleet status: learning. Internal to status.ts. */

import type {
  FleetSkillCorpusReadinessInput,
  FleetSkillCorpusReadiness,
  FleetLearningSourceName,
  LearningSourceQualityLike,
  FleetLearningSourceAvailability,
  FleetLearningMetricAvailability,
  FleetLearningWithholdingReason,
  FleetPostMergeCompositeProjection,
  FleetReadinessEvidenceQuality,
} from './status-types.js';
import {
  SKILL_RETRIEVAL_POLICY_VERSION,
  inspectVerifiedSkillCorpus,
} from './skill-retrieval.js';
import {
  MIN_SKILL_OBSERVED_TRAJECTORIES,
  type TrajectoryLearningStatus,
  type TrajectoryRecordCoverage,
} from '../autonomy/trajectory-records.js';
import {
  readSkillCardCorpus,
} from './skill-records.js';
import {
  readinessSourceQuality,
} from './status-readiness-signals.js';
import {
  createHash,
} from 'node:crypto';
import type {
  DispatchProductionSourceQuality,
} from './dispatch-production-ledger.js';
import type {
  AttemptCoverageStatus,
  AttemptRecordCoverage,
} from '../autonomy/attempt-records.js';
import type {
  PostMergeObservationReadResult,
} from './post-merge-observations.js';
import {
  type PostMergeStabilityReadResult,
  postMergeStabilityRepoDigest,
  type PostMergeStabilityCohortSummary,
} from './post-merge-stability.js';

export function buildSkillCorpusReadiness(
  input: FleetSkillCorpusReadinessInput,
): FleetSkillCorpusReadiness {
  const observedCoverage = input.skillObservation?.observedTrajectoryCoverage;
  const selectedObservations = input.observationState === 'degraded'
    ? 'degraded'
    : input.observationState === 'present' || input.skillObservation?.eventState === 'present'
      ? 'present'
      : input.skillObservation?.sampleState === 'none' || input.skillObservation === undefined
        ? 'none'
        : 'present';
  const sampleState = selectedObservations === 'degraded'
    ? 'unavailable'
    : selectedObservations === 'none'
      ? 'none'
      : input.skillObservation?.sampleState === 'observed'
        ? 'observed'
        : 'insufficient-sample';
  const state: FleetSkillCorpusReadiness['learning']['state'] =
    input.corpusState === 'degraded'
      ? 'blocked-corpus-degraded'
      : selectedObservations === 'degraded'
        ? 'blocked-observation-degraded'
        : input.corpusState === 'no-cards'
          ? 'blocked-no-cards'
          : input.eligibleSignedCards === 'none'
            ? 'awaiting-eligible-cards'
            : selectedObservations === 'none'
              ? 'awaiting-selection'
              : sampleState === 'observed'
                ? 'observable'
                : 'k-gated';

  return {
    version: 1,
    mode: 'shadow',
    policyVersion: input.policyVersion ?? SKILL_RETRIEVAL_POLICY_VERSION,
    corpus: {
      state: input.corpusState,
      sourceQuality: input.corpusSourceQuality,
    },
    eligibleSignedCards: input.eligibleSignedCards,
    selectedObservations,
    learning: {
      state,
      minimumObservedTrajectories: MIN_SKILL_OBSERVED_TRAJECTORIES,
      sampleState,
      ...(sampleState === 'observed' && observedCoverage
        ? { observedTrajectoryCoverage: observedCoverage }
        : {}),
    },
  };
}

export async function readSkillCorpusReadiness(
  skillObservation: TrajectoryLearningStatus['skillObservation'] | undefined,
  observationState: 'none' | 'present' | 'degraded',
): Promise<FleetSkillCorpusReadiness> {
  try {
    const corpusResult = readSkillCardCorpus();
    const inspection = inspectVerifiedSkillCorpus(corpusResult.cards);
    const degraded = corpusResult.sourceState === 'degraded' || inspection.conflicting > 0;
    const corpusState: FleetSkillCorpusReadiness['corpus']['state'] = degraded
      ? 'degraded'
      : corpusResult.cards.length === 0
        ? 'no-cards'
        : 'ready';
    const detail = corpusState === 'degraded'
      ? corpusResult.limitExceeded
        ? 'signed skill corpus exceeds bounded read limits'
        : inspection.conflicting > 0
          ? 'signed skill corpus has conflicting current revisions'
          : corpusResult.invalidRows > 0
            ? 'signed skill corpus contains invalid lifecycle rows'
            : `signed skill corpus is incomplete (${corpusResult.unreadableFiles} unreadable partition(s))`
      : corpusState === 'no-cards'
        ? corpusResult.sourceState === 'missing'
          ? 'no signed skill card ledger exists yet'
          : 'signed skill corpus is readable and contains no cards'
        : 'signed skill corpus is readable';
    const sourceQuality = readinessSourceQuality({
      status: degraded ? 'degraded' : corpusResult.sourceState === 'missing' ? 'unavailable' : 'healthy',
      freshness: 'fresh',
      empty: corpusState === 'no-cards',
      sourcePresent: corpusResult.sourcePresent,
      sourceDegraded: degraded,
      detail,
    });

    return buildSkillCorpusReadiness({
      corpusState,
      corpusSourceQuality: sourceQuality,
      eligibleSignedCards: inspection.eligible > 0 ? 'available' : 'none',
      skillObservation,
      observationState,
      policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
    });
  } catch {
    return buildSkillCorpusReadiness({
      corpusState: 'degraded',
      corpusSourceQuality: readinessSourceQuality({
        status: 'degraded',
        freshness: 'fresh',
        empty: false,
        sourcePresent: true,
        sourceDegraded: true,
        detail: 'signed skill corpus diagnostics are unavailable',
      }),
      eligibleSignedCards: 'none',
      skillObservation,
      observationState: 'degraded',
    });
  }
}

const LEARNING_SNAPSHOT_TEXT_KEYS = new Set([
  'argv',
  'cmd',
  'content',
  'contents',
  'detail',
  'diff',
  'env',
  'fileContents',
  'fullReasoning',
  'promptContext',
  'reason',
  'stderr',
  'stdout',
  'summary',
  'title',
]);

/**
 * Produce a deterministic metadata-only projection for an in-memory stability
 * digest. The digest is never returned or persisted.
 */
function learningSnapshotMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(learningSnapshotMetadata);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        LEARNING_SNAPSHOT_TEXT_KEYS.has(key)
          ? `sha256:${createHash('sha256').update(JSON.stringify(entry) ?? 'undefined').digest('hex')}`
          : learningSnapshotMetadata(entry),
      ]),
  );
}

export function learningSnapshotDigest(source: unknown, rows: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(learningSnapshotMetadata({ source, rows })))
    .digest('hex');
}

export function learningSnapshotSourceQuality(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { sourceState: 'degraded', complete: false };
  const source = value as Record<string, unknown>;
  return {
    sourceState: source.sourceState,
    sourcePresent: source.sourcePresent,
    complete: source.complete,
    stopReasons: source.stopReasons,
    reasons: source.reasons,
    invalidFiles: source.invalidFiles,
    invalidRows: source.invalidRows,
    conflictingEvents: source.conflictingEvents,
    duplicateRows: source.duplicateRows,
    supersededRows: source.supersededRows,
    semanticRejectedRows: source.semanticRejectedRows,
    unreadableFiles: source.unreadableFiles,
    limitExceeded: source.limitExceeded,
  };
}

export function invalidatedDispatchProductionSource(
  source: DispatchProductionSourceQuality | undefined,
  stopReason?: 'io-error',
): DispatchProductionSourceQuality {
  const fallback: DispatchProductionSourceQuality = {
    sourceState: 'degraded',
    sourcePresent: true,
    complete: false,
    stopReasons: [],
    filesRead: 0,
    datedFilesRead: 0,
    looseFilesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
  };
  const base = source ?? fallback;
  return {
    ...base,
    sourceState: base.sourceState === 'missing' ? 'missing' : 'degraded',
    complete: false,
    stopReasons: [...new Set([...base.stopReasons, ...(stopReason ? [stopReason] : [])])],
    unreadableFiles: base.unreadableFiles + (stopReason ? 1 : 0),
  };
}

export function learningSnapshotTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const timestampMs = Date.parse(value);
    if (Number.isFinite(timestampMs) && timestampMs > latestMs) {
      latest = value;
      latestMs = timestampMs;
    }
  }
  return latest;
}

export function settledLearningRows<T>(
  rows: readonly T[],
  cutoffMs: number,
  timestamp: (row: T) => string | undefined,
): T[] {
  return rows.filter((row) => {
    const timestampMs = Date.parse(timestamp(row) ?? '');
    return Number.isFinite(timestampMs) && timestampMs <= cutoffMs;
  });
}

const MAX_LEARNING_WITHHOLDING_REASONS = 12;

const MAX_LEARNING_WITHHELD_METRICS = 24;

export function learningSourceAvailability(
  source: FleetLearningSourceName,
  quality: LearningSourceQualityLike | undefined,
): FleetLearningSourceAvailability {
  return {
    source,
    sourceState: quality?.sourceState ?? 'degraded',
    complete: quality?.complete === true,
  };
}

export function learningSourceAvailable(source: FleetLearningSourceAvailability): boolean {
  return source.sourceState === 'healthy' && source.complete;
}

export function learningMetricAvailability(
  sources: FleetLearningSourceAvailability[],
  withheldMetrics: string[],
  totalMetrics: number,
): FleetLearningMetricAvailability {
  const reasons = sources
    .filter((source) => !learningSourceAvailable(source))
    .map((source): FleetLearningWithholdingReason =>
      `${source.source}-source-${source.sourceState === 'missing' ? 'missing' : 'degraded'}`)
    .slice(0, MAX_LEARNING_WITHHOLDING_REASONS);
  const boundedMetrics = [...new Set(withheldMetrics)].slice(0, MAX_LEARNING_WITHHELD_METRICS);
  return {
    state: boundedMetrics.length === 0 ? 'available' : boundedMetrics.length >= totalMetrics ? 'withheld' : 'partial',
    reasons,
    sources: sources.slice(0, MAX_LEARNING_WITHHOLDING_REASONS),
    withheldMetrics: boundedMetrics,
  };
}

export function withholdAttemptJoinMetrics(
  summary: AttemptCoverageStatus,
  unavailable: Set<keyof AttemptRecordCoverage>,
): AttemptCoverageStatus {
  if (unavailable.size === 0) return summary;
  const coverage = { ...summary.coverage };
  for (const key of unavailable) delete coverage[key];
  return {
    ...summary,
    coverage,
    gaps: summary.gaps.filter((gap) => !unavailable.has(gap.kind)),
    recent: summary.recent.map((record) => {
      const recordCoverage = { ...record.coverage };
      for (const key of unavailable) delete recordCoverage[key];
      return { ...record, coverage: recordCoverage };
    }),
  };
}

export function withholdTrajectoryMetrics(
  summary: TrajectoryLearningStatus,
  unavailable: Set<keyof TrajectoryRecordCoverage>,
  options: { terminal: boolean; realized: boolean; traces: boolean },
): TrajectoryLearningStatus {
  const coverage = { ...summary.coverage };
  for (const key of unavailable) delete coverage[key];
  const routeSpine = { ...summary.routeSpine };
  if (unavailable.has('decision')) delete routeSpine.dispatchToDecision;
  if (unavailable.has('evidence')) delete routeSpine.dispatchToEvidence;
  if (!options.terminal) delete routeSpine.dispatchToMerge;
  return {
    ...summary,
    coverage,
    routeSpine,
    ...(!options.terminal ? { terminalOutcomes: undefined, recent: undefined } : {}),
    ...(!options.realized ? { realizedOutcomes: undefined } : {}),
    ...(!options.traces ? { traces: { state: 'degraded', records: [] } } : {}),
    gaps: summary.gaps.filter((gap) => !unavailable.has(gap.kind)),
    ...(summary.recent && options.terminal
      ? {
          recent: summary.recent.map((record) => {
            const recordCoverage = { ...record.coverage };
            for (const key of unavailable) delete recordCoverage[key];
            return { ...record, coverage: recordCoverage };
          }),
        }
      : {}),
  };
}

export function projectPostMergeComposite(
  adverse: PostMergeObservationReadResult,
  stability: PostMergeStabilityReadResult,
): FleetPostMergeCompositeProjection {
  const bothMissing = adverse.sourceState === 'missing' && stability.sourceState === 'missing';
  const complete = adverse.sourceState === 'healthy' && adverse.complete &&
    stability.sourceState === 'healthy' && stability.complete;
  const source: FleetReadinessEvidenceQuality = {
    sourceState: complete ? 'healthy' : bothMissing ? 'missing' : 'degraded',
    sourcePresent: adverse.sourcePresent || stability.sourcePresent,
    complete,
    stopReasons: [...new Set([
      ...adverse.stopReasons,
      ...stability.stopReasons,
      ...(adverse.sourceState === 'missing' ? ['adverse-source-missing'] : []),
      ...(stability.sourceState === 'missing' ? ['stability-source-missing'] : []),
    ])],
    filesRead: adverse.filesRead + stability.filesRead,
    bytesRead: adverse.bytesRead + stability.bytesRead,
    rowsScanned: adverse.physicalRows + stability.physicalRows,
    invalidRows: adverse.invalidRows + stability.invalidRows,
    unreadableFiles: 0,
  };
  if (!complete) return { source };

  const adverseMembers = new Set(adverse.observations.flatMap((row) => {
    const digest = postMergeStabilityRepoDigest(row.repo);
    return digest ? [JSON.stringify([digest, row.proposalId, row.mergeCommit])] : [];
  }));
  const effectiveStability = stability.witnesses.filter((row) => !adverseMembers.has(JSON.stringify([
    row.repoDigest, row.proposalId, row.mergeCommit,
  ])));
  const effectiveSummary: PostMergeStabilityCohortSummary = {
    completeCohorts: new Set(effectiveStability.map((row) => row.cohortId)).size,
    releasedWitnesses: effectiveStability.length,
    distinctRepoDigests: new Set(effectiveStability.map((row) => row.repoDigest)).size,
    ...(effectiveStability.length > 0
      ? { latestCompletedAt: effectiveStability.map((row) => row.stableAt).sort().at(-1) }
      : {}),
  };
  return {
    source,
    cohort: {
      policyEligible: false,
      denominatorComplete: false,
      adverseObservations: adverse.observations.length,
      stability: effectiveSummary,
    },
  };
}
