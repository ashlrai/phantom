import { describe, expect, it } from 'vitest';
import { channelKey, rollupChannels } from './fleet-channels-model.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const entry = (age: number, source: string, text = 'fake message') => ({ at: new Date(now - age).toISOString(), source, text });

describe('channelKey', () => {
  it.each([
    ['Telegram bot', 'telegram'], ['TG', 'telegram'], ['phantom page', 'page'], ['localhost:7790', 'page'],
    ['Desktop app', 'desktop'], ['palette', 'desktop'], ['composer', 'desktop'], ['remote app', 'mobile'],
    ['phone', 'mobile'], ['mobile', 'mobile'], ['email', 'email'], ['fleet-say', 'fleet-say'],
    ['terminal', 'terminal'], ['CLI', 'terminal'], ['unrecognized', 'other'],
  ] as const)('maps %s to %s', (source, expected) => expect(channelKey(source)).toBe(expected));
});

describe('rollupChannels', () => {
  it('counts valid messages at the hour and day boundaries and orders the channels', () => {
    const inbox = [entry(3_600_000, 'TG'), entry(3_600_001, 'Telegram'), entry(86_400_000, 'telegram'), entry(86_400_001, 'telegram'), entry(1, 'phantom page', 'latest\nmessage'), entry(-1, 'mystery'), { at: 'invalid', source: 'email', text: 'fake' }];
    const result = rollupChannels({ inbox, sources: { inbox: 'healthy' }, generatedAt: 'snapshot' }, now)!;
    expect(result.rows.map(row => row.key)).toEqual(['other', 'page', 'telegram', 'desktop', 'terminal', 'email', 'fleet-say', 'mobile']);
    expect(result.rows.find(row => row.key === 'telegram')).toMatchObject({ total: 4, lastHour: 1, last24h: 3, rawSources: ['TG', 'Telegram', 'telegram'] });
    expect(result.rows[0]).toMatchObject({ total: 1, lastHour: 0, last24h: 0 });
    expect(result.rows[1].preview).toBe('latest message');
    expect(result.silent).toEqual(['Desktop app', 'Terminal', 'Email', 'Fleet-say', 'Mobile']);
    expect(result).toMatchObject({ sourceState: 'healthy', generatedAt: 'snapshot' });
  });
  it('clips the latest preview to a word boundary, including a long unbroken word', () => {
    const result = rollupChannels({ inbox: [entry(2, 'telegram', 'old'), entry(1, 'telegram', `${'word '.repeat(30)}end`), entry(1, 'email', 'x'.repeat(150))] }, now)!;
    const telegram = result.rows.find(row => row.key === 'telegram')!;
    expect(telegram.preview).toBe(`${'word '.repeat(23)}word…`);
    expect(result.rows.find(row => row.key === 'email')!.preview).toBe(`${'x'.repeat(119)}…`);
  });
  it('returns null for garbage and omits other when absent', () => {
    expect(rollupChannels(null, now)).toBeNull();
    expect(rollupChannels({ inbox: 'bad' }, now)).toBeNull();
    const result = rollupChannels({ inbox: [] }, now)!;
    expect(result.rows).toHaveLength(7);
    expect(result.silent).toHaveLength(7);
  });
});
