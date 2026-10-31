import { describe, expect, it } from 'vitest';
import { diffNew, filterByKinds, readFeed, sortNewestFirst } from './fleet-events-model.js';

describe('fleet events model', () => {
  it('projects and sorts events and publishes, retaining invalid dates and duplicates', () => {
    const event = { at: 'bad', kind: 'hold', text: '<img>' };
    const feed = readFeed({ events: [event, event, { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'started' }],
      publishesLastHour: [{ job: 'job-1', at: '2026-01-02T00:00:00Z', url: 'https://github.com/a/b/pull/1' }],
      leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 2,
      drop: { pending: [{ file: 'job.json' }], done: 3 }, sources: { runsDir: 'healthy' } });
    expect(feed.items.map(i => i.kind)).toEqual(['publish', 'launch', 'hold', 'hold']);
    expect(new Set(feed.items.map(i => i.id)).size).toBe(4);
    expect(readFeed({ publishesLastHour: [{ job: 'job-1', at: '2026-01-02T00:00:00Z' }] }).items[0].id).toBe(feed.items[0].id);
    expect(filterByKinds(feed.items, new Set(['hold']))).toHaveLength(2);
    expect(diffNew(new Set(feed.items.slice(0, 2).map(i => i.id)), feed.items)).toHaveLength(2);
    expect(sortNewestFirst(feed.items).map(i => i.id)).toEqual(feed.items.map(i => i.id));
    expect(feed).toMatchObject({ leaders: [{ label: 'leader', ageSeconds: 30 }], agents: 2, pending: 1, done: 3, sourceState: 'healthy' });
  });
  it('keeps missing values unknown', () => {
    expect(readFeed({ drop: null, leaders: [] })).toMatchObject({ items: [], leaders: [], agents: null, pending: null, done: null, sourceState: null });
    expect(readFeed(null).items).toEqual([]);
  });
});
