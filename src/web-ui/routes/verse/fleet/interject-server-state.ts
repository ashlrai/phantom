import type { OrderRow, OrderState } from '../fleet-board/order-state-model.js';
import type { OrderStateResult } from '../fleet-board/order-state-query.js';

export interface EntryContract {
  state: OrderState;
  missing: string[];
  asOf: string;
  source: 'server' | 'local';
  /** Lane-hold dependency; only ever set for a server BLOCKED row. */
  blocker: string | null;
}

/** Same rule as `jobsForEntry`: exact heading first, then the `MM-DD HH:MM` key. */
export function matchOrderRow(rows: readonly OrderRow[], entryAt: string): OrderRow | null {
  if (entryAt === '—') return null;
  const exact = rows.find(row => row.at === entryAt);
  if (exact) return exact;
  const match = /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2})(?: ET)?$/.exec(entryAt);
  return match ? rows.find(row => row.key === match[1]) ?? null : null;
}

/**
 * The contract the "Your orders" strip shows wins when the server classified
 * this order; otherwise the trace-only local contract stands. Never upgrades
 * a state from prose, and an unavailable server never means "no orders".
 */
export function entryContract(
  server: OrderStateResult | undefined,
  entryAt: string,
  local: { state: OrderState; missing: string[]; asOf: string },
): EntryContract {
  const row = server?.kind === 'ok' ? matchOrderRow(server.rows, entryAt) : null;
  if (!row) return { ...local, source: 'local', blocker: null };
  return {
    state: row.state, missing: row.missing, asOf: row.asOf, source: 'server',
    blocker: row.state === 'BLOCKED' ? row.blocker ?? null : null,
  };
}
