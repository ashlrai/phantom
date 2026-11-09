/** Fleet status: readiness signals. Internal to status.ts. */

import type {
  FleetNextAction,
  FleetReadinessFreshness,
  FleetReadinessSourceStatus,
  FleetReadinessSourceHealth,
  FleetReadinessSourceQualityBadge,
  FleetReadinessSourceQuality,
  FleetReadinessEvidenceRole,
  FleetReadinessEvidenceQuality,
  FleetReadinessEvidenceApplicability,
  FleetReadinessEvidenceEligibility,
  FleetStatus,
} from './status-types.js';

export const READINESS_DAEMON_STALE_MS = 30 * 60 * 1000;

export const READINESS_QUEUE_STALE_MS = 24 * 60 * 60 * 1000;

export const READINESS_STATUS_STALE_MS = 30 * 60 * 1000;

export function readinessPriorityRank(priority: FleetNextAction['priority']): number {
  switch (priority) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
  }
}

function readinessFreshness(
  observedAt: string | null,
  staleMs: number,
): { freshness: FleetReadinessFreshness; ageMs: number | null } {
  if (!observedAt) return { freshness: 'unknown', ageMs: null };
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return { freshness: 'unknown', ageMs: null };
  const ageMs = Math.max(0, Date.now() - parsed);
  return { freshness: ageMs > staleMs ? 'stale' : 'fresh', ageMs };
}

function readinessBadge(status: FleetReadinessSourceStatus): FleetReadinessSourceHealth['badge'] {
  return status;
}

const READINESS_SOURCE_QUALITY_LABELS: Record<FleetReadinessSourceQualityBadge, string> = {
  'healthy-source': 'healthy source',
  'healthy-zero': 'healthy zero',
  'degraded-source': 'degraded source',
  'missing-source': 'missing source',
  'stale-source': 'stale source',
  'unknown-source': 'unknown source',
};

export function readinessSourceQuality(input: {
  status: FleetReadinessSourceStatus;
  freshness: FleetReadinessFreshness;
  empty: boolean;
  sourcePresent: boolean;
  sourceDegraded: boolean;
  detail: string;
}): FleetReadinessSourceQuality {
  let badge: FleetReadinessSourceQualityBadge;
  if (!input.sourcePresent || input.status === 'unavailable') {
    badge = 'missing-source';
  } else if (input.freshness === 'stale') {
    badge = 'stale-source';
  } else if (input.freshness === 'unknown') {
    badge = 'unknown-source';
  } else if (input.sourceDegraded || input.status === 'degraded') {
    badge = 'degraded-source';
  } else if (input.empty) {
    badge = 'healthy-zero';
  } else {
    badge = 'healthy-source';
  }
  return {
    badge,
    label: READINESS_SOURCE_QUALITY_LABELS[badge],
    empty: input.empty,
    sourcePresent: input.sourcePresent,
    detail: input.detail,
  };
}

export function readinessSource(
  id: FleetReadinessSourceHealth['id'],
  label: string,
  status: FleetReadinessSourceStatus,
  observedAt: string | null,
  staleMs: number,
  detail: string,
  opts?: {
    freshness?: FleetReadinessFreshness;
    empty?: boolean;
    sourcePresent?: boolean;
    sourceDegraded?: boolean;
  },
): FleetReadinessSourceHealth {
  const measured = opts?.freshness
    ? { freshness: opts.freshness, ageMs: null }
    : readinessFreshness(observedAt, staleMs);
  let effectiveStatus = status;
  if (measured.freshness === 'stale' && effectiveStatus === 'healthy') {
    effectiveStatus = 'degraded';
  } else if (measured.freshness === 'unknown' && effectiveStatus === 'healthy') {
    effectiveStatus = 'unknown';
  }
  return {
    id,
    label,
    status: effectiveStatus,
    badge: readinessBadge(effectiveStatus),
    freshness: measured.freshness,
    observedAt,
    ageMs: measured.ageMs,
    detail,
    sourceQuality: readinessSourceQuality({
      status: effectiveStatus,
      freshness: measured.freshness,
      empty: opts?.empty === true,
      sourcePresent: opts?.sourcePresent ?? status !== 'unavailable',
      sourceDegraded: opts?.sourceDegraded === true,
      detail,
    }),
  };
}

function evidenceReadinessSource(input: {
  id: FleetReadinessSourceHealth['id'];
  label: string;
  role: FleetReadinessEvidenceRole;
  quality: FleetReadinessEvidenceQuality | undefined;
  generatedAt: string;
  applicable?: boolean;
  applicability?: Exclude<FleetReadinessEvidenceApplicability, 'disabled'>;
  /** Whether source degradation may synthesize FleetNextAction records. */
  actionSynthesis?: 'eligible' | 'observational-only';
}): FleetReadinessSourceHealth {
  const actionSynthesis = input.role === 'forensics' || input.actionSynthesis === 'observational-only'
    ? 'observational-only'
    : 'eligible';
  if (input.applicable === false) {
    const source = readinessSource(
      input.id,
      input.label,
      'healthy',
      null,
      READINESS_STATUS_STALE_MS,
      `${input.role} evidence is not applicable under the effective fleet policy`,
      { freshness: 'not-applicable', empty: true, sourcePresent: false },
    );
    return {
      ...source,
      category: 'evidence',
      evidenceRole: input.role,
      eligibility: 'not-applicable',
      applicability: 'disabled',
      actionSynthesis,
    };
  }
  const quality = input.quality;
  const gateRole = input.role === 'merge-authority' || input.role === 'merge-gate';
  const observational = !gateRole && actionSynthesis === 'observational-only';
  const degraded = !quality || quality.sourceState === 'degraded' || !quality.complete;
  const missing = quality?.sourceState === 'missing';
  const eligibility: FleetReadinessEvidenceEligibility = observational
    ? 'observational'
    : degraded
      ? 'withheld'
      : missing
        ? 'cold-start'
        : 'eligible';
  const status: FleetReadinessSourceStatus = degraded ? 'degraded' : missing ? 'unavailable' : 'healthy';
  const stop = quality && quality.stopReasons.length > 0 ? `; stopped: ${quality.stopReasons.join(', ')}` : '';
  const detail = quality
    ? missing
      ? `${input.role} evidence has no ledger yet; consumers remain in cold-start mode`
      : `${input.role} evidence ${eligibility}; ${quality.filesRead} file(s), ${quality.rowsScanned} row(s), ` +
        `${quality.invalidRows} invalid, ${quality.unreadableFiles} unreadable${stop}`
    : `${input.role} evidence diagnostics are unavailable; consumers fail closed`;
  const sourceDetail = input.role === 'merge-gate' && degraded
    ? `${detail}; recovery: ashlr fleet evidence doctor ${input.id} --json (read-only); ` +
      'unsigned evidence cannot grant merge authority'
    : detail;
  const source = readinessSource(
    input.id,
    input.label,
    status,
    input.generatedAt,
    READINESS_STATUS_STALE_MS,
    sourceDetail,
    {
      empty: missing || (quality?.rowsScanned ?? 0) === 0,
      sourcePresent: quality?.sourcePresent ?? false,
      sourceDegraded: degraded,
    },
  );
  return {
    ...source,
    category: 'evidence',
    evidenceRole: input.role,
    eligibility,
    applicability: input.applicability ?? 'optional',
    actionSynthesis,
    ...(quality ? { evidenceQuality: { ...quality, stopReasons: [...quality.stopReasons] } } : {}),
  };
}

export function learningEvidenceReadinessSources(
  status: FleetStatus,
  generatedAt: string,
): FleetReadinessSourceHealth[] {
  const autonomyQuality = status.autonomy?.sourceQuality;
  const autonomyEvidenceQuality: FleetReadinessEvidenceQuality | undefined = autonomyQuality
    ? {
        sourceState: autonomyQuality.sourceState,
        sourcePresent: autonomyQuality.sourcePresent,
        complete: autonomyQuality.complete,
        stopReasons: [
          ...(autonomyQuality.limitExceeded ? ['bounded-limit'] : []),
          ...(autonomyQuality.invalidFiles > 0 ? ['invalid-file'] : []),
          ...(autonomyQuality.unreadableFiles > 0 ? ['unreadable-file'] : []),
        ],
        filesRead: autonomyQuality.filesRead,
        bytesRead: autonomyQuality.bytesRead,
        rowsScanned: autonomyQuality.filesRead,
        invalidRows: autonomyQuality.invalidFiles,
        unreadableFiles: autonomyQuality.unreadableFiles,
      }
    : undefined;
  return [
    evidenceReadinessSource({
      id: 'autonomy-packs', label: 'Signed Evidence Authority', role: 'merge-authority',
      quality: autonomyEvidenceQuality, generatedAt, applicability: 'required',
    }),
    evidenceReadinessSource({
      id: 'decisions', label: 'Unsigned Decision Merge Gate', role: 'merge-gate',
      quality: status.decisionsSource, generatedAt, applicability: 'required',
      actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'judge-traces', label: 'Judge Outcomes', role: 'learning',
      quality: status.judgeTraceSource, generatedAt, actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'agent-actions', label: 'Agent Actions', role: 'learning',
      quality: status.workspace?.sourceQuality, generatedAt, actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'dispatch-production', label: 'Dispatch Outcomes', role: 'analytics',
      quality: status.dispatchProductionSource, generatedAt, actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'dispatch-manifests', label: 'Dispatch Intent', role: 'forensics',
      quality: status.dispatchManifestSource, generatedAt,
      applicable: status.evidencePolicy?.concurrentDispatchEnabled !== false,
    }),
    evidenceReadinessSource({
      id: 'best-of-n', label: 'Candidate Races', role: 'learning',
      quality: status.bestOfNSource, generatedAt, actionSynthesis: 'observational-only',
      applicable: status.evidencePolicy?.bestOfNEnabled !== false,
    }),
    evidenceReadinessSource({
      id: 'post-merge', label: 'Post-Merge Cohort', role: 'forensics',
      quality: status.postMergeSource, generatedAt,
    }),
  ];
}
