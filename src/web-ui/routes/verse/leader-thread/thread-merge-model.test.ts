import { describe, expect, it } from 'vitest';
import { fleetInbox, lineChannel, lineSourceLabel, mergeThread, type ThreadPostShape } from './thread-merge-model.js';

const iso = (t: number) => new Date(t).toISOString();
const NOW = Date.UTC(2026, 9, 31, 18, 0);

function post(over: Partial<ThreadPostShape> & Pick<ThreadPostShape, 'id'>): ThreadPostShape {
  return { at: iso(NOW), from: 'leader', channel: 'verse', kind: 'message', text: 'post', ...over };
}
const entry = (at: string, source: string, text: string) => ({ at, source, text });

describe('mergeThread', () => {
  it('interleaves thread posts and inbox entries oldest first', () => {
    const { lines, undated } = mergeThread(
      [post({ id: 'l1', at: iso(NOW - 30 * 60_000), text: 'first' }), post({ id: 'l2', at: iso(NOW - 10 * 60_000), text: 'third' })],
      [entry(iso(NOW - 20 * 60_000), 'Telegram', 'second')],
      NOW,
    );
    expect(undated).toEqual([]);
    expect(lines.map(line => line.id)).toEqual(['l1', 'inbox-0', 'l2']);
    expect(lines[1]).toMatchObject({ who: 'mason', source: 'Telegram', text: 'second' });
    expect(lines[0]).toMatchObject({ who: 'leader', source: 'verse' });
  });

  it('lists an inbox entry before a thread post at the same instant, stable within each side', () => {
    const at = iso(NOW - 5 * 60_000);
    const { lines } = mergeThread(
      [post({ id: 'l1', at }), post({ id: 'l2', at })],
      [entry(at, 'Phone', 'a'), entry(at, 'Desktop', 'b')],
      NOW,
    );
    expect(lines.map(line => line.id)).toEqual(['inbox-0', 'inbox-1', 'l1', 'l2']);
  });

  it('reads the MASON-INBOX wall-clock format as Eastern time', () => {
    // 2026-10-31 is still EDT (UTC-4): 09:20 ET is 13:20 UTC.
    const { lines } = mergeThread([], [entry('2026-10-31 09:20', 'Telegram', 'morning note')], NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.at).toBe(Date.UTC(2026, 9, 31, 13, 20));
  });

  it('drops an inbox entry relayed verbatim into the thread, but not a leader echo', () => {
    const { lines } = mergeThread(
      [post({ id: 'm1', from: 'mason', channel: 'telegram', text: 'Ship it tonight' })],
      [entry(iso(NOW - 60_000), 'Telegram', '  Ship it tonight  ')],
      NOW,
    );
    expect(lines.map(line => line.id)).toEqual(['m1']);
    expect(lines[0]!.who).toBe('mason');
    const echoed = mergeThread(
      [post({ id: 'l1', text: 'Ship it tonight' })],
      [entry(iso(NOW - 60_000), 'Telegram', 'Ship it tonight')],
      NOW,
    );
    expect(echoed.lines.map(line => line.who)).toEqual(['mason', 'leader']);
  });

  it('places entries with unreadable times last, flagged in undated', () => {
    const { lines, undated } = mergeThread(
      [post({ id: 'l1', at: iso(NOW - 30 * 60_000) })],
      [entry('not a time', 'Desktop', 'when?'), entry(iso(NOW - 40 * 60_000), 'Phone', 'dated')],
      NOW,
    );
    expect(lines.map(line => line.id)).toEqual(['inbox-1', 'l1']);
    expect(undated.map(line => line.id)).toEqual(['inbox-0']);
    expect(Number.isNaN(undated[0]!.at)).toBe(true);
  });
});

describe('lineSourceLabel / lineChannel', () => {
  it('uses the conversation’s channel names, else the source chip map', () => {
    expect(lineSourceLabel('telegram')).toBe('Telegram');
    expect(lineSourceLabel('cli')).toBe('CLI');
    expect(lineChannel('Telegram')).toBe('telegram');
    expect(lineSourceLabel('Phantom desktop')).toBe('Phantom desktop');
    expect(lineSourceLabel('Pager')).toBe('Pager');
    expect(lineChannel('Phantom desktop')).toBeNull();
  });
});

describe('fleetInbox', () => {
  it('returns a read’s inbox rows, [] when absent or malformed', () => {
    const inbox = [entry('2026-10-31 09:20', 'Telegram', 'hi')];
    expect(fleetInbox({ v: 1, inbox })).toBe(inbox);
    expect(fleetInbox(undefined)).toEqual([]);
    expect(fleetInbox({ inbox: [{ at: 1, source: 'x', text: 'y' }] })).toEqual([]);
  });
});
