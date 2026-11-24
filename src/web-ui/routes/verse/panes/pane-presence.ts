let ids: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function hasRegisteredPane(id: string): boolean {
  return ids.has(id);
}

export function publishRegisteredPaneIds(next: Iterable<string>): void {
  const value = new Set(next);
  if (ids.size === value.size && [...ids].every(id => value.has(id))) return;
  ids = value;
  for (const listener of [...listeners]) listener();
}

export function subscribeRegisteredPaneIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
