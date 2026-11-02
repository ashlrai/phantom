import type { liveNodeRows } from './graph-live-model.js';

type LiveNodeRow = ReturnType<typeof liveNodeRows>[number];

export function liveNodeSteerVisible(row: LiveNodeRow): boolean {
  return row.state === 'exhausted' || row.state === 'held' || row.state === 'stale';
}

export function liveNodeSteerPrefill(row: LiveNodeRow): string {
  const text = `Graph node ${row.id} (${row.kind}) is ${row.state}: ${row.usedText}, ${row.resetText}, ${row.ageText}. Reasons: ${row.reasons.join('; ') || 'none given'}. Decide: route around it or wait for the reset.`;
  return text.length < 500 ? text : `${text.slice(0, 498)}…`;
}
