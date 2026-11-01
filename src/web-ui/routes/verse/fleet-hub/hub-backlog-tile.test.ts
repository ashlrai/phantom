import { expect, it } from 'vitest';
import { backlogTile } from './hub-backlog-tile.js';

const now = Date.parse('2026-11-01T04:10:00Z');
const fixture = {
  v: 1, source: 'ok', generatedAt: '2026-11-01T04:06:00Z', items: Array.from({ length: 14 }, () => ({})),
  counts: { mergeState: { DIRTY: 9, BEHIND: 3, CLEAN: 2 }, actions: { recut: 9, merge: 2, refresh: 0, wait: 3, none: 0 } },
};

it('summarizes states and planner actions', () => {
  expect(backlogTile(fixture, now)).toEqual({ text: '14 open · DIRTY 9 · BEHIND 3 · CLEAN 2',
    detail: 'recut 9 · merge 2 · wait 3 · read 4 min ago', tone: 'warn', stale: false });
});
it('warns independently at either threshold', () => {
  const read = (dirty: number, recut: number) => ({ ...fixture, counts: { mergeState: { DIRTY: dirty }, actions: { ...fixture.counts.actions, recut } } });
  expect(backlogTile(read(4, 4), now)?.tone).toBe('ok');
  expect(backlogTile(read(5, 0), now)?.tone).toBe('warn');
  expect(backlogTile(read(0, 5), now)?.tone).toBe('warn');
});
it('reports failed GitHub reads without claiming an empty backlog', () => {
  expect(backlogTile({ ...fixture, source: 'gh-failed', reason: 'gh-pr-list-failed' }, now))
    .toEqual({ text: 'GitHub read failed · gh-pr-list-failed', detail: 'read 4 min ago', tone: 'neutral', stale: false });
  expect(backlogTile({ ...fixture, source: 'gh-failed', reason: 'unsafe reason!' }, now)?.text).toBe('GitHub read failed · unknown');
});
it('marks readings older than 15 minutes stale', () => {
  expect(backlogTile(fixture, Date.parse(fixture.generatedAt) + 900_000)?.stale).toBe(false);
  expect(backlogTile(fixture, Date.parse(fixture.generatedAt) + 900_001)?.stale).toBe(true);
});
it('hides malformed or unsupported snapshots', () => {
  for (const value of [null, {}, { ...fixture, v: 2 }, { ...fixture, generatedAt: 'invalid' },
    { ...fixture, counts: { ...fixture.counts, actions: { recut: -1 } } }, { ...fixture, items: null }]) {
    expect(backlogTile(value, now)).toBeNull();
  }
});
