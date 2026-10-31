import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channelPresenceLine, deriveChannelPresence, leaderPassMs, passClockEt, presenceForChannel,
} from './channel-last-seen.js';
import { KNOWN_CHANNELS } from './fleet-channels-model.js';

// 2026-10-31 is still EDT (UTC-4): an ET wall '00:47' reads as 04:47Z.
const now = Date.parse('2026-10-31T05:00:00Z');
const GENERATED_AT = '2026-10-31T05:00:00.000Z';
const PASS_MS = Date.parse('2026-10-31T04:59:00Z'); // generatedAt minus a 60-second-old leader
const LEADERS = [{ label: 'fake-leader', ageSeconds: 60 }];
const entry = (at: string, source: string, text = 'fake order') => ({ at, source, text });
const byChannel = (inbox: unknown, leaders: unknown = LEADERS, generatedAt: unknown = GENERATED_AT) =>
  new Map(deriveChannelPresence(inbox, leaders, generatedAt, now, KNOWN_CHANNELS).map(row => [row.channel, row]));

afterEach(() => vi.useRealTimers());

describe('deriveChannelPresence', () => {
  it('normalises sources case-insensitively and keeps unknown sources as their own channel', () => {
    const rows = byChannel([
      entry('2026-10-31 00:47', 'Telegram'), entry('2026-10-31 00:48', 'TELEGRAM'),
      entry('2026-10-31 00:30', 'Phantom desktop'), entry('2026-10-31 00:41', 'IRC'), entry('2026-10-31 00:40', 'irc'),
    ]);
    expect(rows.get('telegram')!.lastFromMasonMs).toBe(Date.parse('2026-10-31T04:48:00Z'));
    expect(rows.get('desktop')!.lastFromMasonMs).toBe(Date.parse('2026-10-31T04:30:00Z'));
    expect(rows.get('IRC')!.lastFromMasonMs).toBe(Date.parse('2026-10-31T04:41:00Z'));
    expect(rows.get('IRC')!.count24h).toBe(2);
    expect(rows.get('irc')).toBeUndefined();
    for (const silent of ['page', 'terminal', 'email', 'fleet-say', 'mobile']) {
      expect(rows.get(silent)).toEqual({ channel: silent, lastFromMasonMs: null, count24h: 0, readByPass: null });
    }
  });

  it('keeps every known channel listed when the inbox is empty or unreadable', () => {
    for (const inbox of [[], 'bad', undefined]) {
      const presence = deriveChannelPresence(inbox, LEADERS, GENERATED_AT, now, KNOWN_CHANNELS);
      expect(presence.map(row => row.channel)).toEqual([...KNOWN_CHANNELS]);
      expect(presence.every(row => row.lastFromMasonMs === null && row.count24h === 0 && row.readByPass === null)).toBe(true);
    }
  });

  it('marks a channel read when the newest pass is after its latest message, waiting when older', () => {
    const rows = byChannel([
      entry('2026-10-31 00:47', 'telegram'), // 04:47Z, before the 04:59Z pass
      entry('2026-10-31 01:00', 'email'),    // 05:00Z, after the pass
      entry('2026-10-31 00:59', 'page'),     // 04:59Z, exactly the pass — not yet read
    ]);
    expect(rows.get('telegram')!.readByPass).toBe(true);
    expect(rows.get('email')!.readByPass).toBe(false);
    expect(rows.get('page')!.readByPass).toBe(false);
  });

  it('reports readByPass null when no leader pass is on record', () => {
    const inbox = [entry('2026-10-31 00:47', 'telegram')];
    for (const leaders of [[], [{ label: 'fake', ageSeconds: null }], 'bad', null, undefined]) {
      expect(deriveChannelPresence(inbox, leaders, GENERATED_AT, now, KNOWN_CHANNELS)
        .find(row => row.channel === 'telegram')!.readByPass).toBeNull();
    }
    expect(byChannel(inbox, LEADERS, 'not a date').get('telegram')!.readByPass).toBeNull();
    expect(byChannel(inbox, LEADERS, null).get('telegram')!.readByPass).toBeNull();
  });

  it('counts the trailing 24h and accepts ISO at-strings, skipping entries that cannot be parsed', () => {
    const rows = byChannel([
      { at: '2026-10-31T04:58:00Z', source: 'telegram', text: 'fake iso order' },
      entry('2026-10-30 01:00', 'telegram'), // exactly 24h old, counted
      entry('2026-10-30 00:59', 'telegram'), // outside 24h
      { at: 'garbage', source: 'telegram', text: 'fake' },
      { at: '2026-10-31 00:50', source: ' ', text: 'fake' },
      { source: 'telegram', text: 'fake' },
    ]);
    const telegram = rows.get('telegram')!;
    expect(telegram.lastFromMasonMs).toBe(Date.parse('2026-10-31T04:58:00Z'));
    expect(telegram.count24h).toBe(2);
  });

  it('tracks a message stamped after now without counting it in 24h', () => {
    const rows = byChannel([entry('2026-10-31 02:00', 'telegram')]); // 06:00Z, an hour ahead
    expect(rows.get('telegram')).toMatchObject({ lastFromMasonMs: Date.parse('2026-10-31T06:00:00Z'), count24h: 0, readByPass: false });
  });
});

describe('leaderPassMs', () => {
  it('is generatedAt minus the youngest leader age, or null without a usable pass', () => {
    expect(leaderPassMs(LEADERS, GENERATED_AT)).toBe(PASS_MS);
    expect(leaderPassMs([{ ageSeconds: 90 }, { ageSeconds: 30 }, { ageSeconds: null }], GENERATED_AT)).toBe(Date.parse('2026-10-31T04:59:30Z'));
    expect(leaderPassMs([], GENERATED_AT)).toBeNull();
    expect(leaderPassMs('bad', GENERATED_AT)).toBeNull();
    expect(leaderPassMs(LEADERS, 'bad')).toBeNull();
  });
});

describe('presenceForChannel', () => {
  const presence = deriveChannelPresence([
    entry('2026-10-31 00:47', 'telegram'), entry('2026-10-31 01:00', 'irc'), entry('2026-10-31 00:40', 'radio'),
  ], LEADERS, GENERATED_AT, now, KNOWN_CHANNELS);

  it('returns the row for a known channel and folds every unknown source into other', () => {
    expect(presenceForChannel(presence, 'telegram', KNOWN_CHANNELS)!.channel).toBe('telegram');
    const other = presenceForChannel(presence, 'other', KNOWN_CHANNELS)!;
    expect(other).toMatchObject({ channel: 'other', lastFromMasonMs: Date.parse('2026-10-31T05:00:00Z'), count24h: 2, readByPass: false });
    expect(presenceForChannel(deriveChannelPresence([], LEADERS, GENERATED_AT, now, KNOWN_CHANNELS), 'other', KNOWN_CHANNELS)).toBeUndefined();
  });
});

describe('channelPresenceLine', () => {
  it('renders the per-channel last-heard line', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const silent = { channel: 'email', lastFromMasonMs: null, count24h: 0, readByPass: null };
    expect(channelPresenceLine(undefined, PASS_MS)).toBe('nothing yet');
    expect(channelPresenceLine(silent, PASS_MS)).toBe('nothing yet');
    const heard = { channel: 'telegram', lastFromMasonMs: Date.parse('2026-10-31T04:47:00Z'), count24h: 1, readByPass: true };
    expect(channelPresenceLine(heard, PASS_MS)).toBe('last from you 13m ago · read by the 00:59 pass');
    expect(channelPresenceLine({ ...heard, readByPass: false }, PASS_MS)).toBe('last from you 13m ago · waiting for a leader pass');
    expect(channelPresenceLine({ ...heard, readByPass: null }, null)).toBe('last from you 13m ago · no leader pass yet');
  });

  it('stamps the pass in ET', () => {
    expect(passClockEt(PASS_MS)).toBe('00:59');
  });
});
