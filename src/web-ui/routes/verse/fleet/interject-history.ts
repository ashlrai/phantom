export const HISTORY_KEY = 'phantom.interject.history.v1';

export function loadHistory(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string =>
      typeof item === 'string' && item.length <= 6_000).slice(-20) : [];
  } catch { return []; }
}

export function pushHistory(storage: Pick<Storage, 'getItem' | 'setItem'>, text: string): void {
  try {
    if (text.length > 6_000) return;
    const history = loadHistory(storage);
    if (history.at(-1) !== text) history.push(text);
    storage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-20)));
  } catch { /* Storage can be unavailable. */ }
}

export function recall(history: string[], cursor: number | null, direction: 'up' | 'down'): { cursor: number | null; text: string | null } {
  if (!history.length || (cursor === null && direction === 'down')) return { cursor: null, text: null };
  const next = cursor === null ? history.length - 1 : cursor + (direction === 'up' ? -1 : 1);
  if (next >= history.length) return { cursor: null, text: null };
  const index = Math.max(0, next);
  return { cursor: index, text: history[index]! };
}
