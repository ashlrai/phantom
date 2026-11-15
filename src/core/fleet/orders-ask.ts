/** Exact, short owner "orders" asks: answered in-thread with the per-order
 * reply (orders-reply.ts) naming each order's state, owner job and PR.
 * Anything longer, such as "orders for PR #5315 please", stays a request for
 * the Leader. Normalization matches status-ask.ts and recheck-ask.ts: trim,
 * ≤40 chars, case-insensitive, curly apostrophes folded, trailing ?.! dropped. */
export function isOrdersAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:\/orders|orders|my orders|phantom orders|fleet orders|order state)$/.test(ask);
}
