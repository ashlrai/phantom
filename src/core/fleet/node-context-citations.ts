/** Read citation metadata from a buildNodeContextPack JSONL string. */

interface RawLine {
  jobId?: unknown;
  kind?: unknown;
  text?: unknown;
  truncated?: unknown;
}

/** A parsed JSONL object carrying every field a citation needs. */
interface CitationRecord extends RawLine {
  jobId: string;
  kind: 'task' | 'output';
  text: string;
  truncated: boolean;
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

/** Whether a parsed JSONL object is a usable citation record. */
function isCitationRecord(raw: RawLine | null): raw is CitationRecord {
  return raw !== null &&
    typeof raw.jobId === 'string' && raw.jobId.length > 0 &&
    (raw.kind === 'task' || raw.kind === 'output') &&
    typeof raw.text === 'string' &&
    typeof raw.truncated === 'boolean';
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
    if (!isCitationRecord(raw)) continue;

    const key = `${raw.jobId}::${raw.kind}`;
    if (seen.has(key)) {
      // Update truncation flag: later `true` overrides.
      const existing = results.find(
        r => r.jobId === raw.jobId && r.kind === raw.kind,
      );
      if (existing && raw.truncated) existing.truncated = true;
      continue;
    }

    seen.add(key);
    results.push({ jobId: raw.jobId, kind: raw.kind, truncated: raw.truncated });
  }

  return results;
}

/**
 * Count nonblank lines of a `buildNodeContextPack` JSONL string that are not
 * usable citation records: unparseable JSON, non-object JSON, or objects
 * lacking a nonempty `jobId`, a `'task'`/`'output'` kind, a string `text`,
 * or a boolean `truncated`. Malformed lines are counted, never thrown.
 * No I/O, dependencies, or network.
 */
export function countMalformedNodeContextPackLines(pack: string): number {
  let malformed = 0;
  for (const line of pack.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!isCitationRecord(tryParse(trimmed))) malformed++;
  }
  return malformed;
}
