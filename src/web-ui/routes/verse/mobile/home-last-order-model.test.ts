import { describe, expect, it } from 'vitest';
import { homeLastOrder } from './home-last-order-model.js';
import { mobileTime } from './interject-ack-model.js';

const now = Date.parse('2026-10-31T04:24:00Z');
const order = { at: '2026-10-31 00:16', source: 'phone', text: 'Steer from the phone' };
const snapshot = { generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }], inbox: [order] };

describe('home last order', () => {
  it('shows the newest order waiting for a leader pass', () => {
    expect(homeLastOrder({ ...snapshot, inbox: [{ ...order, text: 'Older' }, order] }, now)).toEqual({
      title: 'Your last order', subtitle: 'phone · 8 m ago: Steer from the phone',
      ackLabel: 'Waiting · next pass due in about 6 min', tone: 'neutral',
    });
  });

  it('maps a seen acknowledgment to the success badge', () => {
    expect(homeLastOrder({ ...snapshot, leaders: [{ ageSeconds: 60 }] }, now)).toMatchObject({
      ackLabel: `Seen by leaders ${mobileTime('2026-10-31T04:19:00Z')}`, tone: 'success',
    });
  });

  it('maps an overdue acknowledgment to warning and keeps unknown neutral', () => {
    expect(homeLastOrder(snapshot, Date.parse('2026-10-31T04:33:00Z'))).toMatchObject({
      ackLabel: 'Waiting · leader pass overdue', tone: 'warning',
    });
    expect(homeLastOrder({ inbox: [order] }, now)).toMatchObject({ ackLabel: 'Leader status unknown', tone: 'neutral' });
  });

  it('omits empty, absent or malformed inboxes', () => {
    for (const value of [null, {}, { inbox: [] }, { inbox: [{}] }]) expect(homeLastOrder(value, now)).toBeNull();
  });

  it('makes a single-line excerpt of at most 80 characters', () => {
    const text = `Hello\n  world\r\n${'x'.repeat(100)}`;
    expect(homeLastOrder({ ...snapshot, inbox: [{ ...order, text }] }, now)?.subtitle)
      .toBe(`phone · 8 m ago: ${`Hello world ${'x'.repeat(100)}`.slice(0, 80)}`);
  });
});
