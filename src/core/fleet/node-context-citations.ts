/** Read citation metadata from a buildNodeContextPack JSONL string. */

interface RawLine {
  jobId?: unknown;
  kind?: unknown;
  text?: unknown;
  truncated?: unknown;
}

/** Parse a single JSONL line; returns parsed object or `null` on failure. */
function tryParse(line: string): RawLine | null {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RawLine) : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate upstream task/output citations from a `buildNodeContextPack`
 * result without retaining or reprinting source text.
 *
 * Reads JSONL records in order; ignores empty/malformed lines and records
 * that lack a nonempty string `jobId`, a recognized `kind` (`'task'` |
 * `'output'`), a string `text`, and a boolean `truncated`.
 *
 * Returns one citation per `(jobId, kind)`, ordered by first occurrence.
 * If a later duplicate has `truncated=true`, that flag wins for the
 * citation. The original `jobId` is preserved exactly.
 *
 * No I/O, dependencies, registry changes, code indexing, or network.
 */
export function readNodeContextCitations(
  pack: string,
): Array<{ jobId: string; kind: 'task' | 'output'; truncated: boolean }> {
  const results: Array<{ jobId: string; kind: 'task' | 'output'; truncated: boolean }> = [];
  const seen = new Set<string>();

  for (const line of pack.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const raw = tryParse(trimmed);
    if (raw === null) continue;

    const jobId = raw.jobId;
    const kind = raw.kind;
    const text = raw.text;
    const truncated = raw.truncated;

    if (typeof jobId !== 'string' || jobId.length === 0) continue;
    if (kind !== 'task' && kind !== 'output') continue;
    if (typeof text !== 'string') continue;
    if (typeof truncated !== 'boolean') continue;

    const key = `${jobId}::${kind}`;
    if (seen.has(key)) {
      // Update truncation flag: later `true` overrides.
      const existing = results.find(
        r => r.jobId === jobId && r.kind === kind,
      );
      if (existing && truncated) existing.truncated = true;
      continue;
    }

    seen.add(key);
    results.push({ jobId, kind, truncated });
  }

  return results;
}
