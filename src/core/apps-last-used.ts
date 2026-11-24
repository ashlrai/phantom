/**
 * Plain words for "when was this app last brought to the front", shared by
 * `phm apps` and the Apps card. Pure: no node imports, safe in the browser bundle.
 * Unknown stays "unknown"; a never-focused app says "not yet", never 0 or now.
 */
export interface LastUsedRow { lastFocus: 'known' | 'never' | 'unknown'; lastFocusedAt: string | null }

export function lastUsedText(row: LastUsedRow, now: number = Date.now()): string {
  if (row.lastFocus === 'never') return 'not yet';
  if (row.lastFocus !== 'known' || !row.lastFocusedAt) return 'unknown';
  const at = Date.parse(row.lastFocusedAt);
  if (!Number.isFinite(at)) return 'unknown';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
