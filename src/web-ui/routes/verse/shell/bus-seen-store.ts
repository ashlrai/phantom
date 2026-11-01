const KEY = 'verse.bus.seen.v1';
const listeners = new Set<() => void>();
let fallback: number | null = null;

export function readSeenCursor(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return fallback ?? 0;
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'cursor' in value && Number.isSafeInteger(value.cursor) && (value.cursor as number) >= 0) {
      return Math.max(value.cursor as number, fallback ?? 0);
    }
  } catch { /* Storage can be unavailable or corrupt. */ }
  return fallback ?? 0;
}

export function markSeen(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) return;
  const next = Math.max(readSeenCursor(), cursor);
  try { localStorage.setItem(KEY, JSON.stringify({ cursor: next })); fallback = null; }
  catch { fallback = next; }
  listeners.forEach(listener => listener());
}

export function subscribeSeenCursor(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) { fallback = null; listener(); }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}
