import type { WorldLaneRow } from '../resources/world-lane-rows.js';

/** Describe only current world readings for the lanes covered by this note. */
export function worldLaneNote(lanes: readonly string[], rows: readonly WorldLaneRow[]): string | null {
  const clauses = lanes.flatMap((lane) => {
    const row = rows.find((candidate) => candidate.freshness === 'fresh' && (candidate.lane === lane || candidate.key === lane));
    if (!row) return [];
    const usage = row.usage.endsWith(' used') ? row.usage : `${row.usage} used`;
    return [`${row.label} ${usage}, ${row.remaining} left, from ${row.source}, ${row.age}`];
  });
  return clauses.length ? `Lane capacity from the world model: ${clauses.join('; ')}.` : null;
}
