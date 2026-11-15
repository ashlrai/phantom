/**
 * routes/verse/leader-thread/leader-draft-store.ts: text other surfaces (the
 * Feed's "Ask Leader") hand to the Leader composer. The composer takes it on
 * mount and whenever it changes; taking clears it, so it lands once and is
 * never sent by itself.
 */
let pending = '';
const listeners = new Set<() => void>();

export function setLeaderDraft(text: string): void {
  pending = text;
  for (const listener of listeners) listener();
}

/** The waiting draft, cleared; '' when none. */
export function takeLeaderDraft(): string {
  const text = pending;
  pending = '';
  return text;
}

export function subscribeLeaderDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
