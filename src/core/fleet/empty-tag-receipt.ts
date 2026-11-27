/** Receipt vocabulary shared by the empty-tag recorder and outcome readers. */
export const EMPTY_TAG_RECEIPT_SCHEMA = 'job.empty-tag.v1';
export const EMPTY_TAGS = ['already_done', 'pool_cap', 'blocked', 'no_change_needed', 'unknown'] as const;
export type EmptyTag = (typeof EMPTY_TAGS)[number];

const validTags: ReadonlySet<string> = new Set(EMPTY_TAGS);

export function parseEmptyTagReceipt(line: string, throughMs = Infinity): { job: string; tag: EmptyTag } | null {
  if (!line.includes(EMPTY_TAG_RECEIPT_SCHEMA)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { schema, job, tag, ts } = parsed as Record<string, unknown>;
  if (schema !== EMPTY_TAG_RECEIPT_SCHEMA || typeof job !== 'string' || job.length === 0 || job.length > 200) return null;
  if (typeof tag !== 'string' || !validTags.has(tag)) return null;
  if (ts !== undefined) {
    const at = typeof ts === 'string' ? Date.parse(ts) : NaN;
    if (!Number.isFinite(at) || at > throughMs) return null;
  }
  return { job, tag: tag as EmptyTag };
}
