import { memoryContentUnchanged, validMemoryId } from '../memory/validate.js';

/** Implementations must validate writes and enforce both scope fields on every query. */
export interface RankedContextStore {
  put(item: RankedContextItem): void;
  query(query: RankedContextQuery): RankedContextItem[];
}
export interface RankedContextItem {
  id: string;
  tenantId: string;
  ownerId: string;
  text: string;
  createdAt: number;
  importance: number;
  accuracy: number;
  /** Only authored summaries are accepted, never raw screen captures or transcripts. */
  contentKind: 'summary';
}
export interface RankedContextQuery {
  tenantId: string;
  ownerId: string;
  now: number;
  limit: number;
}
const screenContent = /(?:data:image\/|<svg\b|<html\b|\bscreenshot\b|\bscreen\s*(?:contents?|capture|text|dump)\b|\b(?:ocr|accessibility)\s*(?:text|dump|tree|output)\b)/i;
export function validRankedContextItem(item: RankedContextItem): boolean {
  return !!item && typeof item === 'object' && Object.keys(item).sort().join(',') ===
    'accuracy,contentKind,createdAt,id,importance,ownerId,tenantId,text' &&
    validMemoryId(item.id) && validMemoryId(item.tenantId) && validMemoryId(item.ownerId) &&
    typeof item.text === 'string' && item.text.trim().length > 0 && Buffer.byteLength(item.text) <= 4096 &&
    memoryContentUnchanged(item.text) && !screenContent.test(item.text) &&
    // Long opaque strings are refused even when the general scrubber treats them as benign.
    !/[A-Za-z0-9_+/=-]{32,}/.test(item.text) &&
    item.contentKind === 'summary' && Number.isFinite(item.createdAt) && item.createdAt >= 0 &&
    Number.isFinite(item.importance) && item.importance >= 0 && item.importance <= 1 &&
    Number.isFinite(item.accuracy) && item.accuracy >= 0 && item.accuracy <= 1;
}
/** Equal weights; recency has a seven-day half-life. Future timestamps get no bonus. */
export function rankContext(items: RankedContextItem[], query: RankedContextQuery): RankedContextItem[] {
  if (!query || !validMemoryId(query.tenantId) || !validMemoryId(query.ownerId) ||
    !Number.isFinite(query.now) || query.now < 0 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    throw new Error('Invalid ranked context query.');
  const score = (item: RankedContextItem) => item.importance + item.accuracy +
    2 ** (-Math.max(0, query.now - item.createdAt) / (7 * 86400000));
  return items.filter(item => validRankedContextItem(item) && item.tenantId === query.tenantId && item.ownerId === query.ownerId)
    .sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, query.limit).map(item => ({ ...item }));
}
