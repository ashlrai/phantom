import { describe, expect, it } from 'vitest';
import {
  AWAY_SESSIONS_SHOWN, awayOutcomeWords, awaySessionCounts, awaySessionsPartial, awaySessionsShown, awaySessionsUnknown, endedWhileAway,
  mergeAwaySessions, type AwaySession,
} from './catchup-sessions-model.js';
import { awayFleet } from './catchup-sessions.test-support.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const MIN = 60_000;
const away = (minutes: number) => ({ since: NOW - minutes * MIN, until: NOW });
const row = (over: Partial<AwaySession>): AwaySession => ({ id: 'RQ-X', session: 'RQ-X', lane: 'claude', kind: 'worker', state: 'done',
  endedAt: new Date(NOW - 5 * MIN).toISOString(), outcome: null, ...over });

describe('endedWhileAway', () => {
  it('lists the sessions that ended inside the window, with how each ended', () => {
    const list = awayFleet(NOW, [
      { job: 'RQ-PR', minutesAgo: 12, outcome: 'pr' },
      { job: 'RQ-FAILED', lane: 'codex-local', minutesAgo: 5, outcome: 'failed' },
      { job: 'RQ-BEFORE', minutesAgo: 45, outcome: 'empty' },
    ]);
    const rows = mergeAwaySessions([], endedWhileAway(list, away(30)));
    // Failed first, then the most recently ended; the one that ended before he left is not his news.
    expect(rows.map(item => [item.id, item.state, item.lane, item.outcome])).toEqual([
      ['RQ-FAILED', 'failed', 'codex-local', null],
      ['RQ-PR', 'done', 'claude', 'Opened a pull request'],
    ]);
    expect(rows[1]!.endedAt).toBe(new Date(NOW - 12 * MIN).toISOString());
    expect(rows[1]!.session).toBe('RQ-PR');
  });

  it('leaves out a running session and one whose end time the list does not hold', () => {
    const list = awayFleet(NOW, [{ job: 'RQ-DONE', minutesAgo: 3, outcome: null }]);
    const rows = endedWhileAway(list, away(30));
    // RQ-RUN is still running; the completed helper has no recorded end time, so it cannot be placed in the window.
    expect(rows.map(item => item.id)).toEqual(['RQ-DONE']);
    expect(awayOutcomeWords(rows[0]!)).toBe('Outcome unknown');
  });

  it('does not count a session that ended after he came back', () => {
    const list = awayFleet(NOW, [{ job: 'RQ-LATER', minutesAgo: 1, outcome: 'pr' }]);
    expect(endedWhileAway(list, { since: NOW - 30 * MIN, until: NOW - 2 * MIN })).toEqual([]);
  });

  it('gives no rows from a list that holds running sessions only', () => {
    const list = awayFleet(NOW, [{ job: 'RQ-PR', minutesAgo: 12, outcome: 'pr' }], { live: true });
    expect(endedWhileAway(list, away(30))).toEqual([]);
    expect(awaySessionsUnknown(list, false)).toBe('this session list holds running sessions only');
  });
});

describe('what the card can and cannot say', () => {
  it('calls an unread list unknown, and a read in flight nothing yet', () => {
    expect(awaySessionsUnknown(null, false)).toBe('the session list could not be read');
    expect(awaySessionsUnknown(undefined, true)).toBe('the session list could not be read');
    expect(awaySessionsUnknown(undefined, false)).toBeNull();
    expect(awaySessionsUnknown(awayFleet(NOW, []), false)).toBeNull();
  });

  it('marks an absence longer than the list remembers as partial', () => {
    expect(awaySessionsPartial(away(60))).toBe(false);
    expect(awaySessionsPartial(away(61))).toBe(true);
  });

  it('counts each side and leaves an empty one out', () => {
    expect(awaySessionCounts([row({}), row({ session: 'b' }), row({ session: 'c', state: 'failed' })])).toBe('2 finished · 1 failed');
    expect(awaySessionCounts([row({ state: 'failed' })])).toBe('1 failed');
    expect(awaySessionCounts([row({})])).toBe('1 finished');
  });

  it('says nothing more about a failed session and names a missing outcome on a finished one', () => {
    expect(awayOutcomeWords(row({ state: 'failed' }))).toBeNull();
    expect(awayOutcomeWords(row({ outcome: 'Ended with no change' }))).toBe('Ended with no change');
    expect(awayOutcomeWords(row({}))).toBe('Outcome unknown');
  });
});

describe('mergeAwaySessions', () => {
  it('keeps a row the list has since forgotten and returns the same rows when a poll changes nothing', () => {
    const first = mergeAwaySessions([], [row({ id: 'RQ-OLD', session: 'RQ-OLD', endedAt: new Date(NOW - 50 * MIN).toISOString() })]);
    const same = mergeAwaySessions(first, []);
    expect(same).toBe(first);
    expect(mergeAwaySessions(first, [...first])).toBe(first);
    const next = mergeAwaySessions(first, [row({ id: 'RQ-NEW', session: 'RQ-NEW' })]);
    expect(next.map(item => item.id)).toEqual(['RQ-NEW', 'RQ-OLD']);
  });

  it('takes the newer record of a session it already holds', () => {
    const first = mergeAwaySessions([], [row({})]);
    const next = mergeAwaySessions(first, [row({ outcome: 'Opened a pull request' })]);
    expect(next).toHaveLength(1);
    expect(next[0]!.outcome).toBe('Opened a pull request');
  });
});

describe('awaySessionsShown', () => {
  const many = [
    ...Array.from({ length: 6 }, (_, index) => row({ id: `RQ-F${index}`, session: `RQ-F${index}`, state: 'failed' })),
    ...Array.from({ length: 3 }, (_, index) => row({ id: `RQ-D${index}`, session: `RQ-D${index}` })),
  ];

  it('never folds a failed session away', () => {
    expect(awaySessionsShown(many, false).map(item => item.state)).toEqual(Array.from({ length: 6 }, () => 'failed'));
    expect(awaySessionsShown(many, true)).toHaveLength(9);
  });

  it('shows the first few when few failed', () => {
    const rows = [many[0]!, ...Array.from({ length: 6 }, (_, index) => row({ id: `RQ-D${index}`, session: `RQ-D${index}` }))];
    expect(awaySessionsShown(rows, false)).toHaveLength(AWAY_SESSIONS_SHOWN);
  });
});
