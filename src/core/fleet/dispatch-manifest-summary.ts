/** Read-only aggregation of dispatch intent; this does not describe execution. */
import type {
  DispatchManifestEvent,
  DispatchManifestEventsReadResult,
  DispatchManifestSourceQuality,
} from './dispatch-manifest.js';

export interface DispatchIntentCounts {
  manifests: number;
  claimed: number;
  assigned: number;
  unassigned: number;
  assignmentsByBackend: Record<string, number>;
}

export interface DispatchManifestEvidenceSummary {
  /** Missing source is unknown; incomplete reads, conflicts, or invalid times are partial. */
  coverage: 'complete' | 'partial' | 'unknown';
  sourceQuality: DispatchManifestSourceQuality;
  total: DispatchIntentCounts;
  dryRun: DispatchIntentCounts;
  live: DispatchIntentCounts;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  invalidTimestampCount: number;
  /** Extra rows sharing an ID, including rows belonging to conflicting groups. */
  duplicateRows: number;
  /** IDs whose records differ; every record in each such group is excluded. */
  conflictingManifests: number;
}

function emptyCounts(): DispatchIntentCounts {
  return { manifests: 0, claimed: 0, assigned: 0, unassigned: 0, assignmentsByBackend: {} };
}

// Compare JSON data by value, independently of object key insertion order.
// Array order remains significant, so any disagreement is surfaced.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function addCounts(counts: DispatchIntentCounts, event: DispatchManifestEvent): void {
  counts.manifests++;
  counts.claimed += event.claimedItemIds.length;
  counts.assigned += event.assignments.length;
  counts.unassigned += event.unassigned.length;
  for (const { backend } of event.assignments) {
    counts.assignmentsByBackend[backend] = (counts.assignmentsByBackend[backend] ?? 0) + 1;
  }
}

/**
 * Summarize a detailed reader result without I/O or mutation. Counts refer to
 * observed manifest entries, not unique items across different manifests.
 * Equal duplicate IDs count once; differing records for an ID are all omitted.
 * Timestamps are normalized to UTC and exclude invalid values.
 */
export function summarizeDispatchManifestEvidence(input: DispatchManifestEventsReadResult): DispatchManifestEvidenceSummary {
  const sourceQuality: DispatchManifestSourceQuality = {
    sourceState: input.sourceState, sourcePresent: input.sourcePresent, complete: input.complete,
    stopReasons: [...input.stopReasons], filesRead: input.filesRead, bytesRead: input.bytesRead,
    rowsScanned: input.rowsScanned, invalidRows: input.invalidRows, unreadableFiles: input.unreadableFiles,
  };
  const groups = new Map<string, { event: DispatchManifestEvent; fingerprint: string; conflict: boolean }>();
  let duplicateRows = 0;
  for (const event of input.events) {
    const fingerprint = canonical(event);
    const existing = groups.get(event.manifestId);
    if (existing) {
      duplicateRows++;
      if (existing.fingerprint !== fingerprint) existing.conflict = true;
    } else {
      groups.set(event.manifestId, { event, fingerprint, conflict: false });
    }
  }

  const total = emptyCounts();
  const dryRun = emptyCounts();
  const live = emptyCounts();
  let earliest = Infinity;
  let latest = -Infinity;
  let invalidTimestampCount = 0;
  let conflictingManifests = 0;
  for (const group of groups.values()) {
    if (group.conflict) { conflictingManifests++; continue; }
    const { event } = group;
    addCounts(total, event);
    addCounts(event.dryRun ? dryRun : live, event);
    const time = Date.parse(event.ts);
    if (!Number.isFinite(time)) invalidTimestampCount++;
    else { earliest = Math.min(earliest, time); latest = Math.max(latest, time); }
  }

  for (const counts of [total, dryRun, live]) {
    counts.assignmentsByBackend = Object.fromEntries(Object.entries(counts.assignmentsByBackend).sort(([a], [b]) => a.localeCompare(b)));
  }

  return {
    coverage: !sourceQuality.sourcePresent || sourceQuality.sourceState === 'missing' ? 'unknown'
      : sourceQuality.sourceState !== 'healthy' || !sourceQuality.complete || conflictingManifests > 0 || invalidTimestampCount > 0
        ? 'partial' : 'complete',
    sourceQuality, total, dryRun, live,
    earliestTimestamp: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
    latestTimestamp: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
    invalidTimestampCount, duplicateRows, conflictingManifests,
  };
}
