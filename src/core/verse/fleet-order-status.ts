/**
 * Owner action for the desktop Goals pane: close, drop or reopen one order
 * (intent ledger item). Writes only the ledger, through updateIntent.
 *
 * The owner-facing words map to the real ledger statuses:
 *   done    -> 'closed'      (finished; 'verified' is reserved for evidence of deployment)
 *   dropped -> 'superseded'  (no longer wanted)
 *   queued  -> 'queued'      (reopen)
 * The reply is the same capped OrderRow the read view serves, never evidence
 * or provenance.
 */
import { updateIntent } from '../intent/edit.js';
import { IntentError, MAX_TITLE, validIntentId, type IntentStatus } from '../intent/schema.js';
import { readLedger } from '../intent/store.js';
import { toOrderRow, type OrderRow } from './fleet-orders-view.js';

export const ORDER_STATUS_TARGETS = ['done', 'dropped', 'queued'] as const;
export type OrderStatusTarget = (typeof ORDER_STATUS_TARGETS)[number];
export const ORDER_STATUS_MAP: Record<OrderStatusTarget, IntentStatus> = { done: 'closed', dropped: 'superseded', queued: 'queued' };
export const ORDER_STATUS_MAX_NOTE = 300;
const NOTE_REF = 'desktop-orders';

export class OrderStatusError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); this.name = 'OrderStatusError'; }
}

export interface ApplyOrderStatusInput { id: string; status: string; note?: string }

export async function applyOrderStatus(
  input: ApplyOrderStatusInput,
  opts: { root?: string; now?: () => number } = {},
): Promise<OrderRow> {
  const { id, status, note } = input;
  if (typeof id !== 'string' || !validIntentId(id)) throw new OrderStatusError(400, 'Invalid order id.');
  if (typeof status !== 'string' || !(ORDER_STATUS_TARGETS as readonly string[]).includes(status)) {
    throw new OrderStatusError(400, 'Status must be done, dropped or queued.');
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > ORDER_STATUS_MAX_NOTE)) {
    throw new OrderStatusError(400, `Note must be at most ${ORDER_STATUS_MAX_NOTE} characters.`);
  }
  const target = ORDER_STATUS_MAP[status as OrderStatusTarget];
  const cleanNote = note?.replace(/[\r\n]+/g, ' ').trim();
  const nowMs = opts.now?.() ?? Date.now();
  try {
    const current = (await readLedger(opts.root)).items.find(item => item.id === id);
    if (!current) throw new OrderStatusError(404, 'Order not found.');
    if (current.status === target) throw new OrderStatusError(400, `Order is already ${status === 'queued' ? 'queued' : status}.`);
    const updated = await updateIntent(id, {
      status: target,
      now: new Date(nowMs).toISOString(),
      // Evidence is a caller-reported note; its notes are capped by edit.ts at MAX_TITLE.
      ...(cleanNote ? { evidence: { ref: NOTE_REF, note: cleanNote.slice(0, MAX_TITLE) } } : {}),
    }, opts.root);
    return toOrderRow(updated, nowMs);
  } catch (error) {
    if (error instanceof OrderStatusError) throw error;
    if (error instanceof IntentError) throw new OrderStatusError(/not found/i.test(error.message) ? 404 : 400, error.message);
    throw error;
  }
}
