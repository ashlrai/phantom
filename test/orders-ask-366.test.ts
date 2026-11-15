/** RQ-PHX-SLACKORDERSASK366 — isOrdersAsk: the exact, short owner "orders"
 * ask set answered in-thread by orders-reply.ts. Anything longer, or any
 * other phrasing, stays a request for the Leader. */
import { describe, expect, it } from 'vitest';
import { isOrdersAsk } from '../src/core/fleet/orders-ask.js';

describe('isOrdersAsk', () => {
  it.each([
    'orders', '/orders', 'my orders', 'phantom orders', 'fleet orders', 'order state',
    'Orders?', 'ORDERS!', '  Phantom Orders.  ', 'Order State?', '/ORDERS', 'MY ORDERS',
    'orders?!', 'fleet orders.',
  ])('accepts %j', ask => { expect(isOrdersAsk(ask)).toBe(true); });

  it.each([
    'orders for PR #5315 please', 'status', 'recheck', '', '   ', 'order', 'orders please',
    'show orders', 'my order', 'fleet order', 'order states', 'orders state', 'orders status',
    'the orders', 'orders list', 'list orders', 'recent orders',
  ])('rejects %j', ask => { expect(isOrdersAsk(ask)).toBe(false); });

  it('rejects a 41-char string even when it otherwise reads as an orders ask', () => {
    const long = `orders${' '.repeat(34)}x`;
    expect(long).toHaveLength(41);
    expect(isOrdersAsk(long)).toBe(false);
    const padded = `${'orders'.padEnd(40, '?')}?`;
    expect(padded).toHaveLength(41);
    expect(isOrdersAsk(padded)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isOrdersAsk(undefined as unknown as string)).toBe(false);
    expect(isOrdersAsk(null as unknown as string)).toBe(false);
  });

  it('folds a curly apostrophe the same way status-ask does — without opening a new ask', () => {
    expect(isOrdersAsk('orders’')).toBe(false);
    expect(isOrdersAsk('mason’s orders')).toBe(false);
  });
});
