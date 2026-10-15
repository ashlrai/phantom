import type { MemoryFactEvent, MemoryPackQuery } from './types.js';
/** Caller supplies admitted canonical IDs; no basename, global, personal, alias or owner fallback. */
export function memoryScopeVisible(event: MemoryFactEvent, query: MemoryPackQuery): boolean {
  return event.projectId === query.projectId && event.ownerId === query.ownerId && event.audienceIds.includes(query.audienceId);
}
export function sameMemoryScope(a: MemoryFactEvent, b: MemoryFactEvent): boolean {
  return a.projectId === b.projectId && a.ownerId === b.ownerId
    && [...a.audienceIds].sort().join('\0') === [...b.audienceIds].sort().join('\0');
}
export function sameMemorySlot(a: MemoryFactEvent, b: MemoryFactEvent): boolean {
  return sameMemoryScope(a, b) && a.subjectKey === b.subjectKey && a.slotKey === b.slotKey;
}
