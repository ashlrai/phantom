/** Lane-label helpers for fleet UI views.
 *
 * Callers must not use these strings as lookup keys; the lane id (passed
 * in) stays the key.  These helpers are only for readable rendering in
 * tables, cards, and status indicators.
 */

/** Return a human-readable label for a lane id. */
export function laneLabel(lane: string): string {
  const known: Record<string, string> = {
    'codex-personal': 'Codex personal',
    'codex-cmp': 'Codex CMP',
    'codex-local': 'Local models',
    'claude': 'Claude',
    'claude-api': 'Claude API',
    'devin': 'Devin',
  };
  const mapped = known[lane];
  if (mapped !== undefined) return mapped;
  return normaliseLabel(lane);
}

/** Return a short two-to-five character label suitable for tight tables. */
export function laneShort(lane: string): string {
  const short: Record<string, string> = {
    'personal': 'PERS',
    'cmp': 'CMP',
    'local': 'LOCAL',
    'claude': 'CL',
    'api': 'API',
    'devin': 'DEVIN',
  };
  const mapped = short[lane];
  if (mapped !== undefined) return mapped;
  return normaliseShort(lane);
}

/* -- internal helpers -- */

function normaliseLabel(lane: string): string {
  if (typeof lane !== 'string' || lane.trim().length === 0) return 'Unknown lane';
  const cleaned = lane.trim().replace(/[-_]+/g, ' ');
  return (cleaned.charAt(0).toUpperCase() + cleaned.slice(1)).replace(/\b(\w)/g, (m, c) => c.toUpperCase());
}

function normaliseShort(lane: string): string {
  if (typeof lane !== 'string' || lane.trim().length === 0) return '?';
  const trimmed = lane.trim().replace(/[-_]+/g, ' ');
  const upper = trimmed.toUpperCase();
  return upper.slice(0, 4);
}
