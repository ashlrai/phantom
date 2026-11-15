import { describe, expect, it } from 'vitest';
import { buildFeed, inboxOverAdapter } from './feed-model.js';

const SCHEMA = 'fleet.gmail-archive-plan-latest.v1';
const AT = '2026-11-09T10:00:00.000Z';
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const plan = (inbox: string, unread: number, target = 100, at = AT) =>
  ({ inbox, at, unread, target, archiveCount: Math.max(0, unread - target), topSenders: [{ sender: 'news@example.test', count: 40 }, { sender: 'ads@example.test', count: 9 }] });
const payload = (...plans: unknown[]) => ({ schema: SCHEMA, latest: { schema: SCHEMA, plans } });

describe('inboxOverAdapter', () => {
  it('raises one alert for an inbox over target', () => {
    const items = inboxOverAdapter(payload(plan('work@example.test', 130)), NOW);
    expect(items).toEqual([{
      id: `inbox-over:work@example.test:${AT}`, at: AT, kind: 'alert', label: 'Inbox',
      title: 'work@example.test: 130 unread, target 100',
      body: 'The archive plan would archive 30. Top senders: news@example.test (40), ads@example.test (9)',
    }]);
  });

  it('omits the sender list when there are none', () => {
    const [item] = inboxOverAdapter(payload({ ...plan('work@example.test', 130), topSenders: [] }), NOW);
    expect(item!.body).toBe('The archive plan would archive 30.');
  });

  it('raises nothing at or under target', () => {
    expect(inboxOverAdapter(payload(plan('work@example.test', 100), plan('home@example.test', 12)), NOW)).toEqual([]);
  });

  it('raises only for the inbox that is over', () => {
    const items = inboxOverAdapter(payload(plan('work@example.test', 101), plan('home@example.test', 40)), NOW);
    expect(items.map(i => i.title)).toEqual(['work@example.test: 101 unread, target 100']);
  });

  it('marks a plan older than 24 h as stale', () => {
    const [item] = inboxOverAdapter(payload(plan('work@example.test', 130)), Date.parse(AT) + 25 * 3_600_000);
    expect(item!.title).toBe('work@example.test: 130 unread, target 100 (plan is stale)');
  });

  it('gives nothing for the wrong schema, a null plan or junk', () => {
    expect(inboxOverAdapter({ schema: 'other.v1', latest: { schema: SCHEMA, plans: [plan('work@example.test', 130)] } }, NOW)).toEqual([]);
    expect(inboxOverAdapter({ schema: SCHEMA, latest: { schema: 'other.v1', plans: [plan('work@example.test', 130)] } }, NOW)).toEqual([]);
    expect(inboxOverAdapter({ schema: SCHEMA, latest: null }, NOW)).toEqual([]);
    expect(inboxOverAdapter(payload({ inbox: 'work@example.test', unread: 'many' }), NOW)).toEqual([]);
    expect(inboxOverAdapter(null, NOW)).toEqual([]);
    expect(inboxOverAdapter(undefined, NOW)).toEqual([]);
  });
});

describe('buildFeed with inbox plans', () => {
  it('keeps the item and dedupes a repeated payload', () => {
    const p = payload(plan('work@example.test', 130));
    expect(buildFeed({ inboxPlans: p }).filter(i => i.label === 'Inbox')).toHaveLength(1);
    const twice = buildFeed({ inboxPlans: p, needsYou: [] });
    expect(twice.map(i => i.id)).toEqual([`inbox-over:work@example.test:${AT}`]);
  });
});
