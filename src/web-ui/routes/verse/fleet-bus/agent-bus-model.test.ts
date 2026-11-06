import { describe, expect, it } from 'vitest';
import { busStatusLine, envelopeRows, isMasonInterjection } from './agent-bus-model.js';
import { narrowAgentBusPage, narrowAgentBusStatus, type AgentBusReceipt } from './agent-bus-queries.js';

const receipt = (cursor: number, body: unknown, ttl = 1000): AgentBusReceipt => ({ cursor, receivedAt: 1000,
  envelope: { id: `fake-${cursor}`, from: cursor === 3 ? 'mason' : 'agent', to: 'all', priority: 'P2', ttl, body } });
const status = { v: 1 as const, source: 'available' as const, retainedCount: 42, liveCount: 40, expiredCount: 2,
  retainedBytes: 31 * 1024, maxMessages: 1024, maxBytes: 1048576 };

describe('durable bus rows', () => {
  it('sorts, shapes, sanitizes and marks expired envelopes', () => {
    const rows = envelopeRows([receipt(1, { text: 'old' }, 500), receipt(2, { task: 'fake' }, 5000),
      receipt(3, { kind: 'interjection', channel: 'telegram', text: `  hi\u0000${'x'.repeat(210)}  ` }, 5000)], 2000);
    expect(rows.map(row => row.cursor)).toEqual([3, 2, 1]);
    expect(rows[0]).toMatchObject({ kind: 'interjection', channel: 'telegram', at: '1970-01-01T00:00:01.000Z', ageText: '1s ago', expired: false });
    expect(rows[0].excerpt).toHaveLength(200);
    expect(rows[0].excerpt).not.toContain('\u0000');
    expect(isMasonInterjection(rows[0])).toBe(true);
    expect(rows[1]).toMatchObject({ kind: 'message', channel: null, excerpt: '{"task":"fake"}' });
    expect(rows[2].expired).toBe(true);
  });
  it('accepts only known channels and short kinds', () => {
    const channels = ['email', 'telegram', 'mobile', 'desktop', 'page', 'cli', 'unknown'];
    expect(envelopeRows(channels.map((channel, i) => receipt(i + 1, { kind: 'x'.repeat(65), channel })), 1000)
      .reverse().map(row => [row.kind, row.channel])).toEqual(channels.map(channel => ['message', channel === 'unknown' ? null : channel]));
  });
  it('formats available and missing status, including unknown counts', () => {
    expect(busStatusLine(status)).toBe('42 retained · 40 live · 2 expired · 31 KB');
    expect(busStatusLine({ ...status, source: 'missing' })).toBe('durable bus storage missing');
    expect(busStatusLine({ ...status, liveCount: null })).toContain('— live');
  });
  it('rejects invalid versions and envelope or status fields', () => {
    const page = { v: 1, status: 'ok', messages: [receipt(1, { fake: true })], nextCursor: 1 };
    expect(narrowAgentBusPage(page)).not.toBeNull();
    expect(narrowAgentBusPage({ ...page, v: 2 })).toBeNull();
    expect(narrowAgentBusPage({ ...page, messages: [receipt(1, undefined)] })).toBeNull();
    expect(narrowAgentBusPage({ ...page, messages: [{ ...page.messages[0], envelope: { ...page.messages[0].envelope, priority: 'urgent' } }] })).toBeNull();
    expect(narrowAgentBusStatus(status)).not.toBeNull();
    expect(narrowAgentBusStatus({ ...status, retainedBytes: -1 })).toBeNull();
  });
});
