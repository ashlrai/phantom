import { describe, expect, it } from 'vitest';
import { normalizeWorkOrder, planWorkOrder } from '../src/core/comms/work-order.js';

const order = { id: 'order-1', type: 'review', repo: 'ashlrai/phantom', task: 'Review the change', acceptance: 'List findings', replyChannel: 'imessage' };

describe('work order proposals', () => {
  it('routes reasoning to the dot and implementation to the fleet without granting authority', () => {
    expect(planWorkOrder(order)).toMatchObject({ destination: 'dot', authority: 'proposal-only' });
    expect(planWorkOrder({ ...order, type: 'implementation' })).toMatchObject({ destination: 'fleet', authority: 'proposal-only' });
  });
  it('requires explicit bounded fields and refuses secret-shaped content', () => {
    expect(normalizeWorkOrder({ ...order, repo: '../bad' })).toBeNull();
    expect(normalizeWorkOrder({ ...order, acceptance: '' })).toBeNull();
    expect(normalizeWorkOrder({ ...order, extra: true })).toBeNull();
    expect(normalizeWorkOrder({ ...order, task: 'x'.repeat(2001) })).toBeNull();
    expect(normalizeWorkOrder({ ...order, task: 'sk-' + 'a'.repeat(48) })).toBeNull();
  });
});
