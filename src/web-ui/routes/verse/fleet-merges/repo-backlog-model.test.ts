import { expect, it } from 'vitest';
import { ageText, repoBacklogView, type RepoBacklog } from './repo-backlog-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const repo = (name: string, open: number, dirty: number, extra: Partial<RepoBacklog> = {}): RepoBacklog =>
  ({ repo: name, state: 'ok', open, dirty, behind: 0, clean: 0, oldestDirtyAt: null, ...extra });
const gone = (name: string, state: 'not-enrolled' | 'unavailable'): RepoBacklog => ({ ...repo(name, 0, 0), state });

it('sorts most DIRTY first, then most open, unreadable repos last', () => {
  const { rows } = repoBacklogView([
    gone('example-org/zeta', 'unavailable'), repo('example-org/alpha', 5, 1), repo('example-org/beta', 9, 1),
    repo('example-org/gamma', 2, 4), gone('example-org/eta', 'not-enrolled'),
  ], NOW);
  expect(rows.map(row => row.repo)).toEqual(['example-org/gamma', 'example-org/beta', 'example-org/alpha', 'example-org/zeta', 'example-org/eta']);
});

it('builds the headline from readable repos only', () => {
  const { headline } = repoBacklogView([
    repo('example-org/alpha', 30, 6), repo('example-org/beta', 11, 3), gone('example-org/gamma', 'unavailable'), gone('example-org/delta', 'unavailable'),
  ], NOW);
  expect(headline).toBe('2 repos · 41 open PRs · 9 DIRTY · 2 repos unavailable');
  expect(repoBacklogView([repo('example-org/alpha', 1, 0), gone('example-org/b', 'unavailable'), gone('example-org/c', 'not-enrolled')], NOW).headline)
    .toBe('1 repo · 1 open PRs · 0 DIRTY · 1 repo unavailable · 1 not enrolled');
});

it('never reports unreadable repos as 0 PRs', () => {
  const { rows } = repoBacklogView([gone('example-org/a', 'unavailable'), gone('example-org/b', 'not-enrolled')], NOW);
  for (const row of rows) expect([row.open, row.dirty, row.behind, row.oldestDirtyText]).toEqual([null, null, null, '—']);
});

it('words the oldest DIRTY age', () => {
  expect(ageText('2026-11-09T11:30:00Z', NOW)).toBe('30 min');
  expect(ageText('2026-11-09T09:00:00Z', NOW)).toBe('3 h');
  expect(ageText('2026-11-07T12:00:00Z', NOW)).toBe('2 d');
  expect(ageText(null, NOW)).toBe('—');
  expect(ageText('garbage', NOW)).toBe('—');
  expect(repoBacklogView([repo('example-org/a', 1, 1, { oldestDirtyAt: '2026-11-07T12:00:00Z' })], NOW).rows[0]!.oldestDirtyText).toBe('2 d');
});
