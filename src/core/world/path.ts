/** Dotted lookup. A missing node is unknown, not a thrown error and not 0. */
import type { WorldModel } from './types.js';

export function worldGet(model: WorldModel, path: string): unknown {
  const parts = path.split('.').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    return { path, freshness: 'unknown', value: null };
  }
  let current: unknown = model;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (Number.isInteger(index) && index >= 0 && index < current.length && String(index) === part) {
        current = current[index];
        continue;
      }
      const named = current.find((item) => item && typeof item === 'object' && (
        (item as { lane?: string }).lane === part
        || (item as { source?: string }).source === part
        || (item as { repo?: string }).repo === part
      ));
      if (!named) return { path, freshness: 'unknown', value: null };
      current = named;
      continue;
    }
    if (current === null || typeof current !== 'object') return { path, freshness: 'unknown', value: null };
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, part)) return { path, freshness: 'unknown', value: null };
    current = record[part];
  }
  return current;
}
