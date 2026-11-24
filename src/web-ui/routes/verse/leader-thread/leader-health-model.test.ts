import { describe, expect, it } from 'vitest';
import { leaderHealthNotice, narrowLeaderHealth, sinceWords } from './leader-health-model.js';

const doc = (over: Record<string, unknown> = {}) => ({
  schema: 'fleet.leader-health.v1', source: 'read', consecutiveFailures: 3, hoursSinceLastSuccess: 4.2,
  lastBetAt: null, cause: 'Claude sign-in expired: run claude login', ...over,
});

describe('narrowLeaderHealth', () => {
  it('reads the document the command prints', () => {
    expect(narrowLeaderHealth(doc())).toEqual({ failures: 3, hoursSinceSuccess: 4.2, cause: 'Claude sign-in expired: run claude login' });
  });

  it('keeps absent evidence unknown instead of zero', () => {
    expect(narrowLeaderHealth(doc({ source: 'unknown', consecutiveFailures: null, hoursSinceLastSuccess: null, cause: null })))
      .toEqual({ failures: null, hoursSinceSuccess: null, cause: null });
    expect(narrowLeaderHealth(doc({ consecutiveFailures: '3', hoursSinceLastSuccess: -1, cause: 7 })))
      .toEqual({ failures: null, hoursSinceSuccess: null, cause: null });
    expect(narrowLeaderHealth(doc({ consecutiveFailures: 1.5 }))?.failures).toBeNull();
  });

  it('is no read at all for another shape', () => {
    for (const raw of [null, undefined, 'x', [], {}, { schema: 'fleet.leader.v1', consecutiveFailures: 3 }]) expect(narrowLeaderHealth(raw)).toBeNull();
  });

  it('holds the cause to one bounded line', () => {
    expect(narrowLeaderHealth(doc({ cause: '  first\nsecond\tthird  ' }))?.cause).toBe('first second third');
    expect(narrowLeaderHealth(doc({ cause: 'x'.repeat(500) }))?.cause).toHaveLength(160);
    expect(narrowLeaderHealth(doc({ cause: '   ' }))?.cause).toBeNull();
  });
});

describe('sinceWords', () => {
  it.each([[0.001, 'under a minute'], [0.42, '25 min'], [1, '1 h'], [4.2, '4 h'], [47.9, '47 h'], [48, '2 d'], [51.5, '2 d 3 h']])('%d hours reads %s', (hours, words) => {
    expect(sinceWords(hours)).toBe(words);
  });
});

describe('leaderHealthNotice', () => {
  it('names the worker a reply box is aimed at, and says why its message waits', () => {
    expect(leaderHealthNotice({ failures: 2, hoursSinceSuccess: 3, cause: 'spawn ENOENT' }, false, 'RQ-A')).toMatchObject({
      state: 'down', headline: 'The Leader’s last 2 passes failed.', cause: 'spawn ENOENT',
      detail: 'A message to RQ-A goes through the Leader, and it is not reading you. What you send is kept in its inbox until a pass succeeds.',
    });
    expect(leaderHealthNotice({ failures: 1, hoursSinceSuccess: 3, cause: null }, false, 'RQ-A')?.detail)
      .toBe('A message to RQ-A goes through the Leader. What you send is kept in its inbox; the next pass may read it.');
    expect(leaderHealthNotice({ failures: 0, hoursSinceSuccess: 0.1, cause: null }, true, 'RQ-A')?.detail).toBe('It reads what you send to RQ-A on its passes, as before.');
    // No job: the Leader chat's own words, unchanged.
    expect(leaderHealthNotice({ failures: 2, hoursSinceSuccess: 3, cause: null }, false, null)?.detail)
      .toBe('It is not reading you. What you send is kept in its inbox until a pass succeeds.');
    expect(leaderHealthNotice({ failures: 0, hoursSinceSuccess: 3, cause: null }, false, 'RQ-A')).toBeNull();
  });

  it('draws nothing without a counted failure', () => {
    expect(leaderHealthNotice(undefined, false)).toBeNull();
    expect(leaderHealthNotice(null, true)).toBeNull();
    expect(leaderHealthNotice({ failures: null, hoursSinceSuccess: 2, cause: 'x' }, true)).toBeNull();
    expect(leaderHealthNotice({ failures: 0, hoursSinceSuccess: 0.1, cause: null }, false)).toBeNull();
  });

  it('warns after one failed pass', () => {
    expect(leaderHealthNotice({ failures: 1, hoursSinceSuccess: 0.5, cause: null }, false)).toEqual({
      state: 'failed', headline: 'The Leader’s last pass failed.',
      detail: 'What you send is kept in its inbox; the next pass may read it.',
      lastGood: 'Last good pass 30 min ago.', cause: null, fix: null,
    });
  });

  it('says the Leader is not reading from two failures in a row, with the fix the cause names', () => {
    expect(leaderHealthNotice(narrowLeaderHealth(doc()), false)).toEqual({
      state: 'down', headline: 'The Leader’s last 3 passes failed.',
      detail: 'It is not reading you. What you send is kept in its inbox until a pass succeeds.',
      lastGood: 'Last good pass 4 h ago.', cause: 'Claude sign-in expired: run claude login', fix: 'claude login',
    });
    expect(leaderHealthNotice({ failures: 2, hoursSinceSuccess: null, cause: 'spawn ENOENT' }, false)).toMatchObject({
      state: 'down', lastGood: 'No good pass is in the dispatch log.', cause: 'spawn ENOENT', fix: null,
    });
  });

  it('says the Leader is passing again only after a failure was shown', () => {
    expect(leaderHealthNotice({ failures: 0, hoursSinceSuccess: 0.05, cause: null }, true)).toMatchObject({
      state: 'recovered', headline: 'The Leader is passing again.', lastGood: 'Last good pass 3 min ago.', cause: null, fix: null,
    });
  });
});
