import { describe, expect, it } from 'vitest';
import { leaderReplyRows } from './leader-replies-model.js';
import type { InboxEntry } from './inbox-tail-query.js';

const NOW = Date.UTC(2026, 10, 4, 18, 0);
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const order = (at: string, text: string): InboxEntry => ({ at, source: 'Phantom mobile', text });
const reply = (at: string, text: string) => ({ at, text });

describe('leaderReplyRows', () => {
  it('interleaves leader replies with Mason lines, newest last', () => {
    const rows = leaderReplyRows(
      [reply(iso(NOW - 10 * MIN), 'Fake answer one'), reply(iso(NOW - 2 * MIN), 'Fake answer two')],
      [order(iso(NOW - 20 * MIN), 'Fake order'), order(iso(NOW - 5 * MIN), 'Second fake order')],
      NOW,
    );
    expect(rows.map(row => row.who)).toEqual(['mason', 'leader', 'mason', 'leader']);
    expect(rows.map(row => row.text)).toEqual(['Fake order', 'Fake answer one', 'Second fake order', 'Fake answer two']);
    expect(rows[3]!.at).toBe(iso(NOW - 2 * MIN));
  });

  it('keeps only the newest eight rows', () => {
    const inbox = Array.from({ length: 6 }, (_, i) => order(iso(NOW - (20 - 2 * i) * MIN), `Fake order ${i}`));
    const outbox = Array.from({ length: 6 }, (_, i) => reply(iso(NOW - (19 - 2 * i) * MIN), `Fake answer ${i}`));
    const rows = leaderReplyRows(outbox, inbox, NOW);
    expect(rows).toHaveLength(8);
    expect(rows.map(row => row.text)).toEqual([
      'Fake order 2', 'Fake answer 2', 'Fake order 3', 'Fake answer 3',
      'Fake order 4', 'Fake answer 4', 'Fake order 5', 'Fake answer 5',
    ]);
  });

  it('truncates long text at 280 chars with an ellipsis', () => {
    const long = Array.from({ length: 60 }, (_, i) => `fakeword${i}`).join(' ');
    const [row] = leaderReplyRows([reply(iso(NOW), long)], [], NOW);
    expect(row!.text.length).toBeLessThanOrEqual(280);
    expect(row!.text.endsWith('…')).toBe(true);
    expect(row!.text.startsWith('fakeword0')).toBe(true);
  });

  it('marks a reply with the order it answers', () => {
    const rows = leaderReplyRows(
      [reply(iso(NOW - 5 * MIN), 'Done, shipped the fake build')],
      [order(iso(NOW - 10 * MIN), 'Ship the fake build')],
      NOW,
    );
    expect(rows[0]).toMatchObject({ who: 'mason', text: 'Ship the fake build' });
    expect(rows[0]!.answers).toBeUndefined();
    expect(rows[1]).toMatchObject({ who: 'leader', text: 'Done, shipped the fake build', answers: 'Ship the fake build' });
  });

  it('keeps the answers link when the order scrolled out of the window', () => {
    const outbox = Array.from({ length: 9 }, (_, i) => reply(iso(NOW - (9 - i) * MIN), `Fake answer ${i}`));
    const rows = leaderReplyRows(outbox, [order(iso(NOW - 30 * MIN), 'The only fake order')], NOW);
    expect(rows).toHaveLength(8);
    expect(rows.every(row => row.who === 'leader' && row.answers === 'The only fake order')).toBe(true);
  });

  it('leaves a reply with no earlier Mason line unmarked', () => {
    const rows = leaderReplyRows([reply(iso(NOW - 5 * MIN), 'Standalone fake note')], [], NOW);
    expect(rows[0]).toMatchObject({ who: 'leader', text: 'Standalone fake note' });
    expect(rows[0]!.answers).toBeUndefined();
  });

  it('carries the kind chip on leader rows only and an empty time on undated entries', () => {
    const rows = leaderReplyRows(
      [reply(iso(NOW - 5 * MIN), 'Needs you: pick a lane'), reply('', 'Undated fake note')],
      [order(iso(NOW - 10 * MIN), 'A fake order')],
      NOW,
    );
    expect(rows[0]!.kind).toBeUndefined();
    expect(rows[1]!.kind).toBe('decision');
    expect(rows[2]).toMatchObject({ who: 'leader', at: '', text: 'Undated fake note' });
  });
});
