/**
 * Match a Resources drawer seat to the world model's row for the same lane.
 *
 * Only a fresh row is returned, so a card never shows a number the world
 * model itself calls stale or unknown. Pure; the hook reads the shared cache.
 */
import { useMemo } from 'react';
import { WORLD_CACHE_TTL_MS } from '../../../../core/world/types.js';
import { useQuery } from '../../../data/hooks.js';
import { canonicalLaneFor, worldLaneRows, type WorldLaneRow } from './world-lane-rows.js';
import { worldModelQuery } from './world-query.js';

export function worldReadingFor(seatId: string, engine: string, rows: readonly WorldLaneRow[]): WorldLaneRow | null {
  const canonical = canonicalLaneFor(seatId);
  let match = rows.find((row) => row.key === seatId || row.lane === seatId || (canonical !== null && row.key === canonical)) ?? null;
  if (match === null) {
    const sameEngine = rows.filter((row) => row.engine === engine);
    match = sameEngine.length === 1 ? sameEngine[0]! : null;
  }
  return match !== null && match.freshness === 'fresh' ? match : null;
}

/** Shares the bar's cache entry (same key and freshMs), so every card costs no extra fetch. */
export function useWorldReading(seatId: string, engine: string): WorldLaneRow | null {
  const read = useQuery(worldModelQuery, { freshMs: WORLD_CACHE_TTL_MS });
  const data = read.data;
  return useMemo(() => (data === undefined ? null : worldReadingFor(seatId, engine, worldLaneRows(data, Date.now()))), [data, seatId, engine]);
}
