import type { liveNodeRows } from './graph-live-model.js';

type LiveNodeRow = ReturnType<typeof liveNodeRows>[number];

const NEEDS_DECISION = new Set(['exhausted', 'held', 'stale']);

/** Quote the node's readings and always preserve the requested action within the length cap. */
export function liveNodeSteerPrefill(row: LiveNodeRow, mode: 'steer' | 'handoff' = 'steer'): string {
  const ask = mode === 'handoff'
    ? 'Hand off this node\'s work to another leader or engine, and say who takes it.'
    : NEEDS_DECISION.has(row.state) ? 'Decide: route around it or wait for the reset.' : 'Anything to change here?';
  const details = `Graph node ${row.id} (${row.kind}) is ${row.state}: ${row.usedText}, ${row.resetText}, ${row.ageText}. Reasons: ${row.reasons.join('; ') || 'none given'}.`;
  const budget = 499 - ask.length - 1;
  return `${details.length <= budget ? details : `${details.slice(0, budget - 1)}…`} ${ask}`;
}
