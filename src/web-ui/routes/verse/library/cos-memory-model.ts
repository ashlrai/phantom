/**
 * routes/verse/library/cos-memory-model.ts: pure helpers for the chief-of-staff
 * memory section of the Library (`/api/verse/cos/memory`). No I/O, no React.
 */
import type { MemoryEntry, MemoryKind } from '../../../../core/cos/memory.js';
import { leaderFileAge } from './library-leader-files-model.js';

export const COS_MEMORY_PATH = '/api/verse/cos/memory';
export const COS_MEMORY_FORGET_PATH = '/api/verse/cos/memory/forget';
export const COS_MEMORY_MAX_CHARS = 2000;
/** Display order: standing rules first, then likes, then loose facts. */
export const COS_MEMORY_KINDS: readonly MemoryKind[] = ['doctrine', 'preference', 'fact'];

export interface CosMemoryRow { id: string; kind: MemoryKind; text: string; source: string; age: string }

const isKind = (v: unknown): v is MemoryKind => COS_MEMORY_KINDS.includes(v as MemoryKind);

function narrowEntry(raw: unknown): MemoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id === '' || !isKind(e.kind) || typeof e.source !== 'string'
    || typeof e.text !== 'string' || typeof e.updated !== 'string') return null;
  return { id: e.id, kind: e.kind, source: e.source, updated: e.updated, text: e.text };
}

/** The entries of a `{v:1, entries}` body; null when the body is not that shape. Malformed rows are dropped. */
export function narrowCosMemory(raw: unknown): MemoryEntry[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.v !== 1 || !Array.isArray(body.entries)) return null;
  return body.entries.map(narrowEntry).filter((e): e is MemoryEntry => e !== null);
}

const stamp = (updated: string): number => {
  const t = Date.parse(updated);
  return Number.isNaN(t) ? 0 : t;
};

/** Rows grouped doctrine, preference, fact; newest first inside a group. */
export function cosMemoryRows(entries: readonly MemoryEntry[], nowMs: number): CosMemoryRow[] {
  return COS_MEMORY_KINDS.flatMap((kind) =>
    entries.filter((e) => e.kind === kind)
      .sort((a, b) => stamp(b.updated) - stamp(a.updated))
      .map((e) => ({
        id: e.id,
        kind,
        text: e.text,
        source: e.source,
        age: Number.isNaN(Date.parse(e.updated)) ? 'unknown age' : leaderFileAge(e.updated, nowMs),
      })));
}

/** One plain sentence for the result of a memory write. `serverError` is the route's fixed refusal text. */
export function cosMemoryOutcome(status: number, serverError?: string | null): string {
  if (status === 200 || status === 201) return 'Remembered.';
  if (status === 401 || status === 403) return 'Unlock to change memory.';
  if (status === 404) return 'This Phantom build cannot change memory from the app.';
  if (status === 422 && serverError) return serverError;
  return 'Could not save. Try again.';
}
