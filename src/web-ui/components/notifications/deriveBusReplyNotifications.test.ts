import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';
import type { AgentBusPage, AgentBusReceipt } from '../../routes/verse/fleet-bus/agent-bus-queries.js';
import { deriveBusReplyNotifications as derive } from './deriveBusReplyNotifications.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const receipt = (id: string, options: Partial<AgentBusReceipt['envelope']> = {}, receivedAt = now - 1000): AgentBusReceipt => ({
  cursor: 1, receivedAt, envelope: { id, from: 'leader', to: 'all', priority: 'P1', ttl: 100_000,
    body: { text: '  Hello\u0000 Mason  ', replyTo: 'mason-composer-fake' }, ...options },
});
const page = (...messages: AgentBusReceipt[]): AgentBusPage => ({ v: 1, status: 'ok', messages, nextCursor: 1 });

describe('bus reply notifications', () => {
  it('finds replies to Mason by prefix or same-page sender, with a stable id and Bus link', () => {
    const mason = receipt('unusual-id', { from: 'mason', body: { text: 'ping' } });
    const reply = receipt('reply-1', { body: { replyTo: 'unusual-id', text: `  Hello\u0000 ${'x'.repeat(150)}  ` } });
    const result = derive(page(mason, reply, reply), now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'bus-reply:reply-1', title: 'leader replied on the bus', actionLabel: 'Open bus' });
    expect(result[0]!.detail).toHaveLength(140);
    expect(result[0]!.detail).not.toContain('\u0000');
    expect(parseDeepLink(new URL(result[0]!.actionHref!).search)).toEqual({ paneId: 'fleet-bus', sessionId: null });
    expect(derive(page(receipt('reply-1')), now + 1)[0]!.id).toBe(result[0]!.id);
  });
  it('ignores replies to another agent and messages from Mason', () => {
    expect(derive(page(receipt('agent-reply', { body: { replyTo: 'other-agent' } }),
      receipt('mason-reply', { from: 'mason', to: 'mason' })), now)).toEqual([]);
  });
  it('includes a direct message to Mason without replyTo', () => {
    expect(derive(page(receipt('direct', { to: 'mason', body: { text: 'Acknowledged' } })), now))
      .toMatchObject([{ id: 'bus-reply:direct', detail: 'Acknowledged' }]);
  });
  it('ignores expired receipts and replies older than 24 hours', () => {
    expect(derive(page(receipt('expired', { ttl: 1000 }),
      receipt('old', { ttl: 200_000_000 }, now - 86_400_001)), now)).toEqual([]);
    expect(derive(null, now)).toEqual([]);
  });
});
