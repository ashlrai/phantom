/**
 * Canary Shadow Report (design-autonomy-canary.md section 4.2, PR plan step 1).
 *
 * Read-only summary of what the shadow canary would have done. It reads only
 * an already-loaded store result and grants no authority: `authority` is
 * always `observation-only` and `activationPermitted` is always false.
 * Would-merge counts are counterfactual, not landed outcomes.
 */
import type {
  AutoMergeCanaryReadResult,
  AutoMergeCanaryShadowMismatchField,
  AutoMergeCanaryShadowOutcome,
} from './automerge-canary-store.js';

export const AUTOMERGE_CANARY_SHADOW_REPORT_SCHEMA_VERSION = 1 as const;
const MAX_LISTED = 50;

export interface CanaryShadowReportEntry {
  observedAt: string;
  outcome: AutoMergeCanaryShadowOutcome;
  headOid: string | null;
  fileCount: number;
  lineCount: number;
  mismatchFields: AutoMergeCanaryShadowMismatchField[];
}

export interface CanaryShadowReport {
  schemaVersion: typeof AUTOMERGE_CANARY_SHADOW_REPORT_SCHEMA_VERSION;
  kind: 'automerge-canary-shadow-report';
  authority: 'observation-only';
  activationPermitted: false;
  counterfactual: true;
  source: { state: AutoMergeCanaryReadResult['sourceState']; status: AutoMergeCanaryReadResult['status']; diagnostics: string[] };
  epochId: string | null;
  counters: { attempts: number; eligible: number; rejected: number; bindingMismatches: number; evidenceUnknown: number };
  /** eligible / attempts, rounded to 4 places; null when there are no attempts. */
  counterfactualYield: number | null;
  wouldHaveMerged: CanaryShadowReportEntry[];
  blocked: CanaryShadowReportEntry[];
  blockingFieldCounts: Partial<Record<AutoMergeCanaryShadowMismatchField, number>>;
  truncated: boolean;
}

export function buildCanaryShadowReport(read: AutoMergeCanaryReadResult): CanaryShadowReport {
  const state = read.state;
  const sc = state?.shadowCounters;
  const counters = {
    attempts: sc?.attempts ?? 0,
    eligible: sc?.eligible ?? 0,
    rejected: sc?.rejected ?? 0,
    bindingMismatches: sc?.bindingMismatches ?? 0,
    evidenceUnknown: sc?.inspectionErrors ?? 0,
  };
  const seen = new Set<string>();
  const entries: CanaryShadowReportEntry[] = [];
  // Only revisions of the current epoch; evidence is deduplicated by digest.
  for (const rev of read.revisions) {
    if (!state || rev.epochId !== state.epochId) continue;
    const ev = rev.lastShadowEvidence;
    if (!ev || seen.has(ev.observationDigest)) continue;
    seen.add(ev.observationDigest);
    entries.push({
      observedAt: ev.observedAt,
      outcome: ev.outcome,
      headOid: ev.headOid,
      fileCount: ev.fileCount,
      lineCount: ev.lineCount,
      mismatchFields: [...ev.mismatchFields].sort(),
    });
  }
  entries.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
  const would = entries.filter((e) => e.outcome === 'eligible');
  const blocked = entries.filter((e) => e.outcome !== 'eligible');
  const blockingFieldCounts: CanaryShadowReport['blockingFieldCounts'] = {};
  for (const e of blocked) for (const f of e.mismatchFields) blockingFieldCounts[f] = (blockingFieldCounts[f] ?? 0) + 1;
  return {
    schemaVersion: AUTOMERGE_CANARY_SHADOW_REPORT_SCHEMA_VERSION,
    kind: 'automerge-canary-shadow-report',
    authority: 'observation-only',
    activationPermitted: false,
    counterfactual: true,
    source: { state: read.sourceState, status: read.status, diagnostics: [...read.diagnostics].sort() },
    epochId: state?.epochId ?? null,
    counters,
    counterfactualYield: counters.attempts > 0 ? Math.round((counters.eligible / counters.attempts) * 10_000) / 10_000 : null,
    wouldHaveMerged: would.slice(-MAX_LISTED),
    blocked: blocked.slice(-MAX_LISTED),
    blockingFieldCounts,
    truncated: would.length > MAX_LISTED || blocked.length > MAX_LISTED,
  };
}

export function formatCanaryShadowReport(report: CanaryShadowReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const c = report.counters;
  const lines = [
    'Auto-merge canary Shadow Report (observation-only, counterfactual; grants no authority)',
    `source: ${report.source.state} / ${report.source.status}${report.source.diagnostics.length ? ` (${report.source.diagnostics.join(', ')})` : ''}`,
    `epoch: ${report.epochId ?? 'none'}`,
    `attempts ${c.attempts}, would-merge ${c.eligible}, rejected ${c.rejected}, binding mismatches ${c.bindingMismatches}, evidence unknown ${c.evidenceUnknown}`,
    `counterfactual yield: ${report.counterfactualYield === null ? 'n/a' : `${(report.counterfactualYield * 100).toFixed(1)}%`}`,
    `would have merged (${report.wouldHaveMerged.length}):`,
    ...report.wouldHaveMerged.map((e) => `  ${e.observedAt} ${e.headOid ?? '-'} files ${e.fileCount} lines ${e.lineCount}`),
    `blocked (${report.blocked.length}):`,
    ...report.blocked.map((e) => `  ${e.observedAt} ${e.outcome}${e.mismatchFields.length ? ` [${e.mismatchFields.join(', ')}]` : ''}`),
  ];
  if (report.truncated) lines.push('(lists truncated to the most recent 50 entries)');
  return `${lines.join('\n')}\n`;
}
