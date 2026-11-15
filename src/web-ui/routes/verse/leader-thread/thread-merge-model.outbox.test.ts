import { describe, expect, it } from 'vitest';
import { fleetOutbox, lineSourceLabel, mergeThread, type ThreadPostShape } from './thread-merge-model.js';

const iso = (t: number) => new Date(t).toISOString();
const NOW = Date.UTC(2026, 9, 31, 18, 0);
const MIN = 60_000;

function post(over: Partial<ThreadPostShape> & Pick<ThreadPostShape, 'id'>): ThreadPostShape {
  return { at: iso(NOW), from: 'leader', channel: 'verse', kind: 'message', text: 'post', ...over };
}
const entry = (at: string, source: string, text: string) => ({ at, source, text });
const answer = (at: string, text: string) => ({ at, text });

describe('mergeThread with MASON-OUTBOX answers', () => {
  it('interleaves outbox lines by time between inbox entries and thread posts', () => {
    const { lines, undated } = mergeThread(
      [post({ id: 'l1', at: iso(NOW - 25 * MIN), text: 'first post' }), post({ id: 'l2', at: iso(NOW - 5 * MIN), text: 'last post' })],
      [entry(iso(NOW - 20 * MIN), 'Telegram', 'question')],
      NOW,
      undefined,
      [answer(iso(NOW - 15 * MIN), 'outbox answer'), answer(iso(NOW - 10 * MIN), 'second answer')],
    );
    expect(undated).toEqual([]);
    expect(lines.map(line => line.id)).toEqual(['l1', 'inbox-0', 'outbox-0', 'outbox-1', 'l2']);
    expect(lines[2]).toMatchObject({ who: 'leader', source: 'outbox', text: 'outbox answer', ack: null });
  });

  it('retains matching leader text from another date', () => {
    const { lines } = mergeThread(
      [post({ id: 'later', at: '2026-11-09T01:00:00Z', text: 'Same answer' })],
      [], NOW, undefined, [answer('2026-11-08T01:00:00Z', 'Same answer')],
    );
    expect(lines.map(line => line.id)).toEqual(['outbox-0', 'later']);
  });

  it('sorts the Mason inbox entry first on a tied timestamp', () => {
    const at = iso(NOW - 5 * MIN);
    const { lines } = mergeThread(
      [post({ id: 'l1', at })],
      [entry(at, 'Desktop', 'question')],
      NOW,
      undefined,
      [answer(at, 'answer')],
    );
    expect(lines.map(line => line.id)).toEqual(['inbox-0', 'outbox-0', 'l1']);
  });

  it('reads MASON-INBOX wall-clock times like the inbox does', () => {
    // 2026-10-31 is still EDT (UTC-4): 09:20 ET is 13:20 UTC.
    const { lines } = mergeThread([], [], NOW, undefined, [answer('2026-10-31 09:20', 'morning answer')]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.at).toBe(Date.UTC(2026, 9, 31, 13, 20));
  });

  it('places unreadable outbox times in undated', () => {
    const { lines, undated } = mergeThread(
      [post({ id: 'l1', at: iso(NOW - 5 * MIN) })],
      [],
      NOW,
      undefined,
      [answer('', 'no heading time'), answer(iso(NOW - 10 * MIN), 'dated')],
    );
    expect(lines.map(line => line.id)).toEqual(['outbox-1', 'l1']);
    expect(undated.map(line => line.id)).toEqual(['outbox-0']);
    expect(Number.isNaN(undated[0]!.at)).toBe(true);
  });

  it('returns today’s result when no outbox argument is given', () => {
    const thread = [post({ id: 'l1', at: iso(NOW - 10 * MIN) })];
    const inbox = [entry(iso(NOW - 20 * MIN), 'Telegram', 'hi')];
    expect(mergeThread(thread, inbox, NOW)).toEqual(mergeThread(thread, inbox, NOW, undefined, []));
  });
});

describe('outbox source chip', () => {
  it('labels the outbox source as the leader’s answer file', () => {
    expect(lineSourceLabel('outbox')).toBe('Leader outbox');
  });
});

describe('fleetOutbox', () => {
  it('returns a read’s outbox rows, [] when absent or malformed', () => {
    const outbox = [answer('2026-10-31 09:20', 'hi')];
    expect(fleetOutbox({ v: 1, outbox })).toBe(outbox);
    expect(fleetOutbox(undefined)).toEqual([]);
    expect(fleetOutbox({})).toEqual([]);
    expect(fleetOutbox({ outbox: [{ at: 'x' }] })).toEqual([]);
  });
});
