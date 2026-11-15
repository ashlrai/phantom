import { describe, expect, it } from 'vitest';
import { orderRowView, parseOrderStateBody } from './order-state-model.js';

const row = (extra: object = {}) => ({ at: '2026-11-14T09:00:00.000Z', source: 'slack', key: 'k', state: 'RECEIVED', asOf: '2026-11-14T10:00:00.000Z', missing: [], pr: null, ...extra });
const view = (extra?: object) => {
  const p = parseOrderStateBody({ v: 1, asOf: 'x', orders: [row(extra)] });
  if (p.kind !== 'ok') throw new Error('unavailable');
  return orderRowView(p.rows[0]!);
};

describe('order thread reply model', () => {
  it('parses an old body without threadReply as quiet', () => {
    expect(view().replyText).toBe('');
  });
  it('maps each value', () => {
    expect(view({ threadReply: 'delivered' }).replyText).toBe('reply delivered');
    expect(view({ threadReply: 'attempted' }).replyText).toBe('reply attempted (unconfirmed)');
    expect(view({ threadReply: 'none' }).replyText).toBe('no reply yet');
    expect(view({ threadReply: 'unknown' }).replyText).toBe('');
  });
  it('treats an invalid value as unknown', () => {
    expect(view({ threadReply: 'sent' }).replyText).toBe('');
    expect(view({ threadReply: 7 }).replyText).toBe('');
  });
});
