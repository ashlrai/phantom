import type { liveNodeRows } from './graph-live-model.js';

type LiveNodeRow = ReturnType<typeof liveNodeRows>[number];

const NEEDS_DECISION = new Set(['exhausted', 'held', 'stale']);

/** Every node can be steered or handed off; readings are quoted as the row shows them (unknown stays unknown). */
export function liveNodeSteerPrefill(row: LiveNodeRow, mode: 'steer' | 'handoff' = 'steer'): string {
  const ask = mode === 'handoff'
    ? 'Hand off this node\'s work to another leader or engine, and say who takes it.'
    : NEEDS_DECISION.has(row.state) ? 'Decide: route around it or wait for the reset.' : 'Anything to change here?';
  const text = `Graph node ${row.id} (${row.kind}) is ${row.state}: ${row.usedText}, ${row.resetText}, ${row.ageText}. Reasons: ${row.reasons.join('; ') || 'none given'}. ${ask}`;
  return text.length < 500 ? text : `${text.slice(0, 498)}…`;
}
