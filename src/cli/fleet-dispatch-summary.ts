/** Read-only dispatch intent rollup; never writes and never contacts a provider. */
import {
  readDispatchManifestEventsDetailed,
  type DispatchManifestEventsReadResult,
} from '../core/fleet/dispatch-manifest.js';
import {
  summarizeDispatchManifestEvidence,
  type DispatchIntentCounts,
  type DispatchManifestEvidenceSummary,
} from '../core/fleet/dispatch-manifest-summary.js';

export type DispatchSummaryReader = () => DispatchManifestEventsReadResult;

export interface DispatchSummaryReport extends DispatchManifestEvidenceSummary {
  schema: 'fleet.dispatch-summary.v1';
  /** Why coverage is not complete; null for a fully healthy read. */
  reason: string | null;
}

const usage = 'Usage: ashlr fleet dispatch-summary [--json]';

// Inspection reads never take the store lock, migrate permissions, or create
// the directory — a summary command must not write to read.
const inspectStore: DispatchSummaryReader = () =>
  readDispatchManifestEventsDetailed({ inspectionOnly: true });

export function dispatchSummaryReason(summary: DispatchManifestEvidenceSummary): string | null {
  if (summary.coverage === 'complete') return null;
  const quality = summary.sourceQuality;
  if (quality.sourceState === 'missing' || !quality.sourcePresent) {
    return 'dispatch manifest store is missing';
  }
  const parts: string[] = [];
  if (quality.unreadableFiles > 0) parts.push(`${quality.unreadableFiles} unreadable file(s)`);
  if (quality.invalidRows > 0) parts.push(`${quality.invalidRows} invalid row(s)`);
  if (quality.stopReasons.length > 0) parts.push(`stopped after ${quality.stopReasons.join(', ')}`);
  if (summary.conflictingManifests > 0) {
    parts.push(`${summary.conflictingManifests} conflicting manifest id(s) withheld`);
  }
  if (summary.invalidTimestampCount > 0) {
    parts.push(`${summary.invalidTimestampCount} invalid timestamp(s)`);
  }
  return parts.length > 0 ? parts.join('; ') : 'evidence is incomplete';
}

function countsLine(label: string, counts: DispatchIntentCounts): string {
  const backends = Object.entries(counts.assignmentsByBackend)
    .map(([backend, n]) => `${backend}=${n}`).join(', ');
  return `  ${`${label}:`.padEnd(10)}${counts.manifests} manifest(s), ${counts.claimed} claimed, ` +
    `${counts.assigned} assigned, ${counts.unassigned} unassigned${backends ? ` (${backends})` : ''}`;
}

/** Render the report as plain text. Pure — no I/O and no color. */
export function formatDispatchSummary(report: DispatchSummaryReport): string {
  const lines = [`Dispatch manifest evidence — coverage ${report.coverage}`];
  if (report.reason !== null) lines.push(`  reason:    ${report.reason}`);
  const quality = report.sourceQuality;
  lines.push(
    `  source:    ${quality.sourceState}, ${quality.filesRead} file(s), ` +
    `${quality.rowsScanned} row(s), ${quality.bytesRead} byte(s)`,
  );
  if (report.coverage === 'unknown') return lines.join('\n');
  lines.push(`  window:    ${report.earliestTimestamp ?? '—'} → ${report.latestTimestamp ?? '—'}`);
  lines.push(countsLine('total', report.total));
  lines.push(countsLine('live', report.live));
  lines.push(countsLine('dry-run', report.dryRun));
  const withheld = [
    report.duplicateRows > 0 ? `${report.duplicateRows} duplicate row(s)` : null,
    report.conflictingManifests > 0 ? `${report.conflictingManifests} conflicting manifest id(s)` : null,
    report.invalidTimestampCount > 0 ? `${report.invalidTimestampCount} invalid timestamp(s)` : null,
  ].filter((part): part is string => part !== null);
  if (withheld.length > 0) lines.push(`  withheld:  ${withheld.join(', ')}`);
  return lines.join('\n');
}

export async function cmdFleetDispatchSummary(
  args: string[],
  reader: DispatchSummaryReader = inspectStore,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'ashlr fleet dispatch-summary [--json]\n' +
      'Read-only rollup of recorded dispatch intent; never writes or contacts a provider.\n' +
      'coverage: complete | partial (degraded read or withheld records) | unknown (no readable store).\n' +
      'Exits 0 only when coverage is complete.',
    );
    return 0;
  }
  const invalid = args.find((arg) => arg !== '--json');
  if (invalid !== undefined) {
    process.stderr.write(`error: unknown option: ${invalid}\n${usage}\n`);
    return 2;
  }
  let input: DispatchManifestEventsReadResult;
  let readFailed = false;
  try {
    input = reader();
  } catch {
    readFailed = true;
    input = {
      events: [], sourceState: 'missing', sourcePresent: false, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 0,
    };
  }
  const summary = summarizeDispatchManifestEvidence(input);
  const report: DispatchSummaryReport = {
    schema: 'fleet.dispatch-summary.v1',
    ...summary,
    reason: readFailed ? 'dispatch manifest evidence could not be read' : dispatchSummaryReason(summary),
  };
  console.log(args.includes('--json') ? JSON.stringify(report) : formatDispatchSummary(report));
  return summary.coverage === 'complete' ? 0 : 1;
}
