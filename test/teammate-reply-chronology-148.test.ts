import { describe, expect, it } from 'vitest';
import { summarizeTeammateLatency } from '../src/core/comms/teammate-reply-latency.js';

const now = Date.parse('2026-01-02T12:00:00Z');
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const text = (rowid: number, age: number, body = 'please check the build?') =>
  ({ v: 1, rowid, at: iso(age), senderId: 'imessage:fake0000', text: body });
const answer = (rowid: number, age: number) => ({ v: 1, answered: rowid, at: iso(age) });

describe('reply chronology', () => {
  it('keeps premature and future markers unanswered', () => {
    const s = summarizeTeammateLatency([answer(1, 31), text(1, 30), text(2, 20), answer(2, -1)], { now });
    expect(s).toMatchObject({ texts: 2, answered: 0, unanswered: 2, withinTarget: 0, oldestUnanswered: { rowid: 1, ageMinutes: 30 } });
  });

  it('selects the earliest valid marker regardless of append order', () => {
    const s = summarizeTeammateLatency([answer(1, 31), text(1, 30), answer(1, 22), answer(1, 27), answer(2, 9), text(2, 10)], { now });
    expect(s).toMatchObject({ answered: 2, unanswered: 0, medianMinutes: 2, maxMinutes: 3, withinTarget: 2 });
  });

  it('excludes future texts, preserves ignored texts and includes the window boundary', () => {
    const s = summarizeTeammateLatency([text(1, -1), text(2, 1440), text(3, 1441), text(4, 10, 'thanks')], { now });
    expect(s).toMatchObject({ texts: 2, ignorable: 1, unanswered: 1, latestTextAt: iso(10), oldestUnanswered: { rowid: 2, ageMinutes: 1440 } });
    expect(summarizeTeammateLatency([text(3, 1441), text(1, -1)], { now }).latestTextAt).toBe(iso(1441));
  });
});
