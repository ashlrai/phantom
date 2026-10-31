import { expect, it } from 'vitest';
import { decisionRows, holdRows, matchesQuery, normalizeQuery, searchRows } from './fleet-decisions-model.js';
import { fixture } from './fixtures.js';

it('trims, collapses, lower-cases and caps the query', () => {
  expect(normalizeQuery('  Foo   BAR ')).toBe('foo bar');
  expect(normalizeQuery('')).toBe('');
  expect(normalizeQuery('   ')).toBe('');
  expect(normalizeQuery('a\tb\nc')).toBe('a b c');
  expect(normalizeQuery('x'.repeat(120))).toBe('x'.repeat(80));
});

it('matches case-insensitive multi-term AND across repo, title, reason, target and holdKind', () => {
  const row = { repo: 'ashlrai/phantom', title: 'Ship RQ-PHX-1', reason: 'No seat free', target: 'lane-a', holdKind: 'cooldown' };
  expect(matchesQuery(row, '')).toBe(true);
  expect(matchesQuery(row, '   ')).toBe(true);
  expect(matchesQuery(row, 'PHANTOM')).toBe(true);
  expect(matchesQuery(row, 'rq-phx-1')).toBe(true);
  expect(matchesQuery(row, 'seat lane-a')).toBe(true);
  expect(matchesQuery(row, 'cooldown')).toBe(true);
  expect(matchesQuery(row, 'seat cooldown')).toBe(true);
  expect(matchesQuery(row, 'seat missing')).toBe(false);
  expect(matchesQuery(row, 'other')).toBe(false);
  expect(matchesQuery({ repo: 'a/b', title: 'T', reason: 'R' }, 'anything')).toBe(false);
});

it('filters decision and hold rows while preserving row identity', () => {
  const fleet = fixture();
  const decisions = decisionRows(fleet, 'all'), held = holdRows(fleet);
  expect(searchRows(decisions, '')).toBe(decisions);
  expect(searchRows(decisions, 'no seat')).toEqual([decisions.find(d => !d.launched)]);
  expect(searchRows(decisions, 'phantom second')).toEqual([decisions.find(d => d.title === 'Second')]);
  expect(searchRows(decisions, 'zzz')).toEqual([]);
  expect(searchRows(held, 'cooldown')).toEqual(held);
  expect(searchRows(held, 'cooldown waiting')).toEqual(held);
  expect(searchRows(held, 'other')).toEqual([]);
});
