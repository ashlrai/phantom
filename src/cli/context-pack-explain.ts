import type { NodeContextPackInput } from '../core/fleet/node-context-pack.js';
import { readNodeContextCitations } from '../core/fleet/node-context-citations.js';
import { summarizeNodeContextCoverage } from '../core/fleet/node-context-coverage.js';

/** Metadata only: never rank again, render source bodies, or echo the query. */
export function explainContextPack(input: NodeContextPackInput, pack: string) {
  const citations = readNodeContextCitations(pack);
  const coverage = new Map(summarizeNodeContextCoverage(input, pack).upstream
    .map(row => [row.jobId, row.state]));
  const eligible = new Set(input.outputs.filter(row => row.jobId.trim() && row.text.trim() &&
    row.jobId !== input.node.jobId).map(row => row.jobId));
  const kinds = new Map<string, Set<'task' | 'output'>>();
  for (const citation of citations) {
    const selected = kinds.get(citation.jobId) ?? new Set<'task' | 'output'>();
    selected.add(citation.kind);
    kinds.set(citation.jobId, selected);
  }
  type Diagnostic = {
    jobId: string;
    eligibleOutput: boolean;
    selectedKinds: Array<'task' | 'output'>;
    outputCoverage: string;
    reason: 'selected' | 'no-eligible-output' | 'budget-omission' | 'unknown';
  };
  const result = {
    eligibleUpstreamOutputJobIds: [] as string[],
    selectedUpstreamOutputJobIds: [] as string[],
    upstream: [] as Diagnostic[],
    omittedDiagnosticCount: 0,
  };
  // Leave room for the count and envelope. IDs are bounded opaque labels;
  // path-like, whitespace-bearing or arbitrary prompt-like IDs are suppressed.
  let remaining = 15 * 1024;
  for (const jobId of new Set(input.node.upstreamJobIds)) {
    if (result.upstream.length >= 100 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) {
      result.omittedDiagnosticCount++;
      continue;
    }
    const selectedKinds = [...(kinds.get(jobId) ?? [])];
    const eligibleOutput = eligible.has(jobId);
    const state = coverage.get(jobId) ?? 'unknown';
    const row: Diagnostic = {
      jobId, eligibleOutput, selectedKinds, outputCoverage: state,
      // Every eligible non-self upstream output is a pack candidate regardless
      // of query. Its absence proves budget omission, but no finer cause.
      reason: jobId === input.node.jobId ? 'unknown'
        : selectedKinds.includes('output') ? 'selected'
          : !eligibleOutput ? 'no-eligible-output'
            : state === 'omitted' ? 'budget-omission' : 'unknown',
    };
    const cost = Buffer.byteLength(JSON.stringify(row)) + 2 * Buffer.byteLength(JSON.stringify(jobId)) + 3;
    if (cost > remaining) {
      result.omittedDiagnosticCount++;
      continue;
    }
    remaining -= cost;
    result.upstream.push(row);
    if (eligibleOutput) result.eligibleUpstreamOutputJobIds.push(jobId);
    if (selectedKinds.includes('output')) result.selectedUpstreamOutputJobIds.push(jobId);
  }
  return result;
}
