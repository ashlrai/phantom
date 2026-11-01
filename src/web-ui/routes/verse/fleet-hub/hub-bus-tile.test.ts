import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt, AgentBusStatus } from '../fleet-bus/agent-bus-queries.js';
import { busTile } from './hub-bus-tile.js';

const now = 10_000_000;
const status: AgentBusStatus = { v: 1, source: 'available', retainedCount: 3, retainedBytes: 41 * 1024,
  liveCount: 3, expiredCount: 0, maxMessages: 1024, maxBytes: 1024 * 1024 };
const receipt = (receivedAt: number, to: string): AgentBusReceipt => ({ cursor: receivedAt, receivedAt,
  envelope: { id: 'fake-id', from: 'agent', to, priority: 'P2', ttl: 1, body: 'fake message' } });

describe('durable bus hub tile', () => {
  it('counts only the last hour and messages addressed to Mason', () => {
    const rows = [receipt(now, 'mason'), receipt(now - 3_600_000, 'agent'), receipt(now - 100, 'all'),
      receipt(now - 3_600_001, 'mason'), receipt(now + 1, 'mason')];
    expect(busTile(status, rows, now)).toEqual({ title: 'Bus', reading: '3 envelopes in the last hour · 1 for you',
      caption: 'Store available · 3 of 1024 · 41 KB of 1 MB', tone: 'ok' });
  });

  it('warns at either capacity threshold, including exactly 90 percent', () => {
    expect(busTile({ ...status, retainedCount: 950 }, [], now)).toMatchObject({ tone: 'warn',
      caption: 'Store available · 950 of 1024 · 41 KB of 1 MB' });
    expect(busTile({ ...status, retainedBytes: 900, maxBytes: 1000 }, [], now).tone).toBe('warn');
    expect(busTile({ ...status, retainedCount: 90, maxMessages: 100 }, [], now).tone).toBe('warn');
    expect(busTile({ ...status, retainedCount: 89, maxMessages: 100 }, [], now).tone).toBe('ok');
    expect(busTile({ ...status, retainedCount: 950, retainedBytes: null }, [], now).tone).toBe('warn');
  });

  it('marks a capped page and does not imply a full history', () => {
    expect(busTile({ ...status, retainedCount: 101 }, [receipt(now, 'mason')], now).reading)
      .toBe('1 envelope in the last hour (of the last 100) · 1 for you');
    expect(busTile({ ...status, retainedCount: 100 }, [], now).reading).not.toContain('of the last 100');
  });

  it('distinguishes unavailable and unknown stores and unavailable pages', () => {
    expect(busTile(null, null, now)).toMatchObject({ tone: 'unknown', caption: 'Store status unknown' });
    expect(busTile({ ...status, source: 'unavailable', retainedCount: null, retainedBytes: null }, null, now))
      .toMatchObject({ tone: 'bad', reading: 'Envelope count unavailable', caption: 'Store unavailable · — of 1024 · — of 1 MB' });
    expect(busTile({ ...status, retainedBytes: null }, null, now).tone).toBe('unknown');
  });
});
