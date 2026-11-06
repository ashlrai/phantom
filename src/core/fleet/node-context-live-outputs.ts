import type { NodeContextPackInput, NodeContextRecord } from './node-context-pack.js';
import { isFleetJobId } from './runs-job-detail.js';
import { getFleetJobText, type FleetJobTextV1 } from './runs-job-texts.js';

export interface LiveOutputSource {
  jobId: string;
  state: FleetJobTextV1['state'];
  source: FleetJobTextV1['source'];
  truncated: boolean;
  /** Retained artifact size before scrubbing and packing, when available. */
  bytes: number | null;
}

/** Read only retained upstream notes, never paths or instructions from their text. */
export async function readNodeContextLiveOutputs(input: NodeContextPackInput): Promise<{
  outputs: NodeContextRecord[]; sources: LiveOutputSource[];
}> {
  const ids = input.node.upstreamJobIds;
  // Validate the entire set before starting any retained-artifact filesystem read.
  if (input.outputs.length || ids.length > 32 || new Set(ids).size !== ids.length ||
      !ids.every(isFleetJobId)) throw new Error('invalid live upstream descriptor');
  const results: FleetJobTextV1[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await getFleetJobText(ids[index]!, 'notes', { maxBytes: 65536 });
    }
  }));
  return {
    outputs: results.flatMap(row => row.state === 'ok' && row.text.trim()
      ? [{ jobId: row.job, text: row.text }] : []),
    sources: results.map(row => ({ jobId: row.job, state: row.state, source: row.source,
      truncated: row.truncated, bytes: row.bytes })),
  };
}

/** A complete retained prefix is still only partial evidence of its source. */
export function markLiveOutputTruncation(pack: string, sources: readonly LiveOutputSource[]): string {
  const partial = new Set(sources.filter(row => row.truncated).map(row => row.jobId));
  return pack.split('\n').map(line => {
    if (!line) return line;
    const row = JSON.parse(line) as { jobId: string; kind: string; truncated: boolean };
    if (row.kind !== 'output' || !partial.has(row.jobId) || row.truncated) return line;
    // false -> true shortens the JSONL record, preserving the builder's byte bound.
    return JSON.stringify({ ...row, truncated: true });
  }).join('\n');
}
