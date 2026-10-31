/** Task/output retrieval only. Code search belongs to grep, not this index. */
export interface NodeContextRecord {
  jobId: string;
  text: string;
}

export interface NodeContextPackInput {
  node: {
    jobId: string;
    /** Caller resolves graph edges (including transitive dependencies if wanted). */
    upstreamJobIds: readonly string[];
    /** Optional lexical search for related records outside the dependency set. */
    query?: string;
  };
  tasks: readonly NodeContextRecord[];
  outputs: readonly NodeContextRecord[];
  byteBudget: number;
}

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

/**
 * Build a deterministic, pure context pack as JSON Lines. Each line contains
 * { jobId, kind, text, truncated }; jobId is always the complete source citation.
 * The budget covers the ENTIRE returned UTF-8 string, including JSON escaping
 * and newlines. Invalid/nonpositive budgets return empty; fractions round down.
 * Oversized text is shortened on Unicode code-point boundaries. If even its
 * citation and envelope cannot fit, the entry is omitted, never uncited.
 *
 * Priority: upstream outputs, upstream tasks, the node's task, then lexical
 * matches from unrelated jobs (descending query overlap). Input order breaks
 * ties. Exact jobId/kind/text duplicates retain their first occurrence.
 * No files, embeddings, network, clock, or caller mutation are involved.
 * Source text is untrusted data, not instructions or execution authority.
 */
export function buildNodeContextPack(input: NodeContextPackInput): string {
  if (!Number.isFinite(input.byteBudget) || input.byteBudget <= 0) return '';
  const budget = Math.floor(input.byteBudget);
  const upstream = new Set(input.node.upstreamJobIds);
  const query = terms(input.node.query ?? '');
  const seen = new Set<string>();
  const candidates = [
    ...input.outputs.map(record => ({ ...record, kind: 'output' as const })),
    ...input.tasks.map(record => ({ ...record, kind: 'task' as const })),
  ].flatMap(record => {
    if (!record.jobId.trim() || !record.text.trim()) return [];
    // A node's own output is not prior context for that node.
    if (record.jobId === input.node.jobId && record.kind === 'output') return [];
    const key = JSON.stringify([record.jobId, record.kind, record.text]);
    if (seen.has(key)) return [];
    seen.add(key);
    const words = terms(record.text);
    const score = [...query].filter(word => words.has(word)).length;
    const priority = upstream.has(record.jobId) ? (record.kind === 'output' ? 0 : 1)
      : record.jobId === input.node.jobId ? 2 : 3;
    return priority === 3 && score === 0 ? [] : [{ ...record, priority, score }];
  }).sort((a, b) => a.priority - b.priority || b.score - a.score);

  let pack = '';
  let used = 0;
  for (const record of candidates) {
    const remaining = budget - used;
    const render = (text: string, truncated: boolean): string =>
      JSON.stringify({ jobId: record.jobId, kind: record.kind, text, truncated }) + '\n';
    let line = render(record.text, false);
    if (Buffer.byteLength(line, 'utf8') > remaining) {
      if (Buffer.byteLength(render('', true), 'utf8') > remaining) continue;
      const points = Array.from(record.text);
      let low = 0;
      let high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(render(points.slice(0, mid).join(''), true), 'utf8') <= remaining) low = mid;
        else high = mid - 1;
      }
      if (low === 0) continue;
      line = render(points.slice(0, low).join(''), true);
    }
    pack += line;
    used += Buffer.byteLength(line, 'utf8');
  }
  return pack;
}
