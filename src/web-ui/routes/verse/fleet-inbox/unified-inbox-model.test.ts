import { expect, it } from 'vitest';
import { itemLine, readUnifiedInboxView, sourceSummary, type UnifiedInboxEntry } from './unified-inbox-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const report = (state: string, pending: number) => ({ state, pending });
const raw = (over: Record<string, unknown> = {}) => ({
  schema: 'comms.unified-inbox.v1', generatedAt: '2026-11-09T12:00:00Z', total: 2, omitted: 0,
  sources: { 'needs-you': report('healthy', 1), imessage: report('healthy', 0), drafts: report('healthy', 1), bus: report('healthy', 0) },
  items: [{ id: 'drafts:d-test1', source: 'drafts', kind: 'draft-approval', severity: 'warn', blocking: true, title: 'Reply to +15550000000', since: '2026-11-09T11:00:00Z', expiresAt: null, act: ['phm comms drafts show d-test1', 7] }],
  ...over,
});
const entry = (over: Partial<UnifiedInboxEntry> = {}): UnifiedInboxEntry => ({
  id: 'bus:b-test1', source: 'bus', kind: 'bus-work', severity: 'info', blocking: false, title: 't', since: null, expiresAt: null, act: [], ...over,
});

it('narrows a valid response and keeps only string act entries', () => {
  const view = readUnifiedInboxView(raw());
  expect(view).toMatchObject({ total: 2, omitted: 0 });
  expect(view && !view.unavailable && view.items[0]).toMatchObject({ id: 'drafts:d-test1', blocking: true, act: ['phm comms drafts show d-test1'] });
});

it('reports unavailable', () => {
  expect(readUnifiedInboxView({ schema: 'comms.unified-inbox.v1', unavailable: true, items: [] })).toEqual({ unavailable: true });
});

it('returns null for malformed responses', () => {
  for (const bad of [null, 'x', [], {}, raw({ schema: 'other' }), raw({ total: '2' }), raw({ sources: null }), raw({ items: {} })]) {
    expect(readUnifiedInboxView(bad)).toBeNull();
  }
});

it('drops items without id or title and with unknown enum values', () => {
  const good = raw().items[0]!;
  const view = readUnifiedInboxView(raw({ items: [
    { ...good, id: undefined }, { ...good, title: 4 }, { ...good, source: 'fax' }, { ...good, kind: 'x' }, { ...good, severity: 'urgent' }, good,
  ] }));
  expect(view && !view.unavailable && view.items.map(i => i.id)).toEqual(['drafts:d-test1']);
});

it('summarises sources, marking non-healthy and showing missing as a dash', () => {
  const view = readUnifiedInboxView(raw({ sources: { 'needs-you': report('healthy', 3), imessage: report('healthy', 1), drafts: report('missing', 0), bus: report('degraded', 2) } }));
  expect(view && !view.unavailable && sourceSummary(view.sources)).toBe('Needs you 3 · iMessage 1 · Drafts — · Bus degraded 2 · Gmail —');
  const healthy = readUnifiedInboxView(raw());
  expect(healthy && !healthy.unavailable && sourceSummary(healthy.sources)).toBe('Needs you 1 · iMessage 0 · Drafts 1 · Bus 0 · Gmail —');
});

it('itemLine labels, ages and flags soon-expiring items', () => {
  expect(itemLine(entry({ source: 'imessage', since: '2026-11-09T11:00:00Z' }), NOW)).toEqual({ label: 'Teammate text', title: 't', age: '1h ago' });
  expect(itemLine(entry({ source: 'needs-you' }), NOW)).toMatchObject({ label: 'Needs you', age: null });
  expect(itemLine(entry({ source: 'drafts' }), NOW).label).toBe('Draft');
  expect(itemLine(entry({ since: '2026-11-09T11:55:00Z', expiresAt: '2026-11-09T12:20:00Z' }), NOW)).toMatchObject({ label: 'Bus work', age: '5m ago · expires in 20m' });
  expect(itemLine(entry({ expiresAt: '2026-11-09T12:31:00Z' }), NOW).age).toBeNull();
});
