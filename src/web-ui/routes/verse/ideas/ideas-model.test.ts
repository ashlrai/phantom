import { describe, expect, it } from 'vitest';
import { groupByRepo, ideasHeadline, rankIdeas, sourceCounts } from './ideas-model.js';

const many = (n: number, source: (i: number) => string) =>
  rankIdeas(Array.from({ length: n }, (_, i) => ({ id: `i${i}`, title: `Idea ${i}`, repo: 'org/a', score: n - i, source: source(i) })));

describe('rankIdeas', () => {
  it('orders by score descending with unscored rows last', () => {
    const rows = rankIdeas([{ id: 'a', repo: 'x' }, { id: 'b', score: 5 }, { id: 'c', score: 50 }]);
    expect(rows.map(r => r.title)).toEqual(['c', 'b', 'a']);
    expect(rows.map(r => r.scoreText)).toEqual(['score 50', 'score 5', 'unscored']);
  });

  it('keeps input order on ties, scored or not', () => {
    const rows = rankIdeas([{ id: 'u1' }, { id: 't1', score: 3 }, { id: 'u2' }, { id: 't2', score: 3 }]);
    expect(rows.map(r => r.title)).toEqual(['t1', 't2', 'u1', 'u2']);
  });

  it('drops rows with neither title nor id, and fills defaults', () => {
    const rows = rankIdeas([{ score: 9 }, { title: '  ' }, { id: 'only-id', repo: '/work/acme/phantom' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'only-id', repo: 'phantom', source: 'unknown' });
    expect(rankIdeas([{ title: 'T' }])[0]?.repo).toBe('unassigned');
  });
});

describe('groupByRepo', () => {
  it('orders repos by best score and caps rows with a more count', () => {
    const rows = rankIdeas([
      { id: 'a1', repo: 'org/a', score: 1 }, { id: 'b1', repo: 'org/b', score: 9 },
      { id: 'a2', repo: 'org/a', score: 8 }, { id: 'a3', repo: 'org/a', score: 7 },
    ]);
    const groups = groupByRepo(rows, 2);
    expect(groups.map(g => g.repo)).toEqual(['org/b', 'org/a']);
    expect(groups[1]!.rows.map(r => r.title)).toEqual(['a2', 'a3']);
    expect(groups[1]!.more).toBe(1);
    expect(groups[0]!.more).toBe(0);
  });
});

describe('ideasHeadline', () => {
  it('summarises count, repos and the top idea', () => {
    const rows = rankIdeas([{ id: 'x', title: 'Fix red main', repo: 'a', score: 2 }, { id: 'y', repo: 'b', score: 1 }]);
    expect(ideasHeadline(rows)).toBe('2 candidates across 2 repos. Top: Fix red main');
  });
  it('says so when there are none', () => expect(ideasHeadline([])).toBe('No candidates yet'));
});

describe('sourceCounts', () => {
  it('counts per source', () => {
    const { counts } = sourceCounts(many(4, i => (i < 3 ? 'issue' : 'planner')));
    expect(counts).toEqual([{ source: 'issue', count: 3 }, { source: 'planner', count: 1 }]);
  });
  it('nudges only at 80% of 10 or more rows', () => {
    expect(sourceCounts(many(10, i => (i < 8 ? 'issue' : 'planner'))).nudge)
      .toBe('Most ideas come from issue; consider adding a goal to widen the search.');
    expect(sourceCounts(many(10, i => (i < 7 ? 'issue' : 'planner'))).nudge).toBeNull();
    expect(sourceCounts(many(9, () => 'issue')).nudge).toBeNull();
  });
});
