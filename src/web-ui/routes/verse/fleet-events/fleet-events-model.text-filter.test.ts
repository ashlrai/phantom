import { describe, expect, it } from 'vitest';
import { filterByText, type FeedItem } from './fleet-events-model.js';

const item = (id: string, kind: string, text: string): FeedItem => ({ id, at: '2026-01-01T00:00:00Z', kind, text, url: null });
const items = () => [
  item('1', 'launch', 'launched job RQ-FAKE-1 in lane dev'),
  item('2', 'hold', 'job RQ-FAKE-1 held by steward'),
  item('3', 'merge', 'merged lane docs'),
  item('4', 'publish', 'published job RQ-OTHER-9'),
];

describe('filterByText', () => {
  it('matches item text case-insensitively, ignoring surrounding whitespace', () => {
    expect(filterByText(items(), 'rq-fake-1').map(i => i.id)).toEqual(['1', '2']);
    expect(filterByText(items(), 'LANE DOCS').map(i => i.id)).toEqual(['3']);
    expect(filterByText(items(), '  rq-fake-1  ').map(i => i.id)).toEqual(['1', '2']);
  });
  it('matches item kind', () => {
    expect(filterByText(items(), 'PUBLISH').map(i => i.id)).toEqual(['4']);
  });
  it('returns every item for blank or whitespace-only text', () => {
    expect(filterByText(items(), '')).toHaveLength(4);
    expect(filterByText(items(), '   ')).toHaveLength(4);
  });
  it('returns an empty list when nothing matches', () => {
    expect(filterByText(items(), 'zzz-no-match')).toEqual([]);
  });
  it('does not mutate the input array', () => {
    const list = items();
    const before = list.map(i => i.id);
    filterByText(list, 'rq-fake-1');
    expect(list.map(i => i.id)).toEqual(before);
  });
});
