/**
 * decide/cache.ts — input-hash cache for Jev answers.
 *
 * Keyed by sha256(kind, model, question schema, salt, state). The same stderr,
 * the same PR title or the same operator message classified twice costs one
 * call, not two. Only SUCCESSFUL answer sets are cached — a timeout or a 429 is
 * a statement about the transport at that moment, not about the input.
 *
 * In-memory and bounded on purpose: the daemon is long-lived (where repeats
 * actually happen), a disk cache would be one more place classified text could
 * leak through its hash-adjacent metadata, and a CLI process that restarts
 * simply pays for one call again.
 */

import { createHash } from 'node:crypto';
import type { TypeSafeOk } from '../classify/typesafe-client.js';

export const DECISION_CACHE_MAX_ENTRIES = 1_000;
export const DECISION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface Entry {
  readonly at: number;
  readonly result: TypeSafeOk;
}

const entries = new Map<string, Entry>();

/** Refresh insertion order on a Map-backed LRU cache. */
export function touchLruEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/** Insert or refresh a Map-backed LRU entry and evict the oldest entries past `maxEntries`. */
export function setLruEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  touchLruEntry(map, key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function cacheKey(parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(String(p.length));
    h.update(':');
    h.update(p);
  }
  return h.digest('hex');
}

export function cacheGet(key: string, now: number = Date.now()): TypeSafeOk | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (now - hit.at > DECISION_CACHE_TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  touchLruEntry(entries, key, hit);
  return hit.result;
}

export function cacheSet(key: string, result: TypeSafeOk, now: number = Date.now()): void {
  setLruEntry(entries, key, { at: now, result }, DECISION_CACHE_MAX_ENTRIES);
}

export function clearDecisionCache(): void {
  entries.clear();
}
