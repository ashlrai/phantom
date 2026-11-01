import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { mirrorByChannel, mirrorHint } from './channel-bus-mirror.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const entry = (source: string, at = now) => ({ source, at: new Date(at).toISOString(), text: 'fake message' });
const receipt = (channel: string, at = now, from = 'mason', kind = 'interjection'): AgentBusReceipt => ({
  cursor: 1, receivedAt: at, envelope: { id: 'fake-id', from, to: 'leaders', priority: 'P0', ttl: 1000, body: { kind, channel } },
});

describe('channel bus mirrors', () => {
  it('includes both window bounds and rejects future, old, invalid and non-interjection entries', () => {
    const inbox = [entry('telegram', now), entry('tg', now - 3_600_000), entry('telegram', now + 1),
      entry('telegram', now - 3_600_001), { at: 'bad', source: 'telegram', text: 'fake' }, { at: new Date(now).toISOString(), source: 'telegram' }];
    const receipts = [receipt('telegram', now), receipt('telegram', now - 3_600_000), receipt('telegram', now + 1),
      receipt('telegram', now - 3_600_001), receipt('telegram', now, 'agent'), receipt('telegram', now, 'mason', 'other')];
    expect(mirrorByChannel(inbox, receipts, now).get('telegram')).toEqual({ inbox: 2, mirrored: 2, tone: 'ok', text: 'mirrored 2 of 2 in the last hour' });
    expect(mirrorByChannel(inbox, receipts, now, 0).get('telegram')).toMatchObject({ inbox: 1, mirrored: 1 });
  });

  it('maps the six publisher channel names explicitly and ignores unknown names', () => {
    const keys = ['email', 'telegram', 'mobile', 'desktop', 'page', 'terminal'] as const;
    const rows = mirrorByChannel([], ['email', 'telegram', 'mobile', 'desktop', 'page', 'cli', 'terminal', 'constructor'].map(name => receipt(name)), now);
    for (const key of keys) expect(rows.get(key)).toMatchObject({ mirrored: 1, tone: 'ok' });
    expect(rows.get('fleet-say')).toMatchObject({ inbox: 0, mirrored: 0, tone: 'none' });
    expect(rows.has('other')).toBe(false);
  });

  it('warns only for channels with inbox entries and no mirrors', () => {
    const inbox = [entry('telegram'), entry('telegram'), entry('telegram'), entry('desktop'), entry('desktop'), entry('desktop'), entry('unknown')];
    const rows = mirrorByChannel(inbox, [receipt('telegram'), receipt('telegram')], now);
    expect(rows.get('telegram')).toMatchObject({ inbox: 3, mirrored: 2, tone: 'ok', text: 'mirrored 2 of 3 in the last hour' });
    expect(rows.get('desktop')).toMatchObject({ inbox: 3, mirrored: 0, tone: 'warn' });
    expect(rows.get('other')).toMatchObject({ inbox: 1, mirrored: 0, tone: 'warn' });
    expect(mirrorHint('warn', 'available')).toBe('Messages reach the inbox but not the bus: the hub needs --allow-dispatch and a writable bus store');
    expect(mirrorHint('warn', 'unavailable')).toBe('Bus unavailable, cannot verify');
    expect(mirrorHint('none', 'unavailable')).toBe('Bus unavailable, cannot verify');
    expect(mirrorHint('warn', 'loading')).toBeNull();
    expect(mirrorHint('ok', 'available')).toBeNull();
  });
});
