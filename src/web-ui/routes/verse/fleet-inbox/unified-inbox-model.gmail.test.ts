import { describe, expect, it } from 'vitest';
import { readUnifiedInboxView, sourceSummary } from './unified-inbox-model.js';

const report = (state: string, pending: number) => ({ state, pending });
const base = {
  schema: 'comms.unified-inbox.v1', generatedAt: '2026-11-09T12:00:00Z', total: 1, omitted: 0,
  sources: { 'needs-you': report('healthy', 0), imessage: report('healthy', 0), drafts: report('healthy', 0), bus: report('healthy', 0) },
  items: [] as unknown[],
};
const gmailItem = {
  id: 'gmail:work@example.test', source: 'gmail', kind: 'gmail-over-target', severity: 'warn', blocking: false,
  title: 'work@example.test: 120 unread, target 100', since: '2026-11-09T11:00:00Z', expiresAt: null, act: ['phm fleet gmail-archive-plan'],
};

describe('unified inbox view, gmail source', () => {
  it('keeps a gmail item', () => {
    const view = readUnifiedInboxView({ ...base, items: [gmailItem] });
    expect(view && !view.unavailable && view.items).toEqual([gmailItem]);
  });

  it('shows the gmail count in the summary', () => {
    const view = readUnifiedInboxView({ ...base, sources: { ...base.sources, gmail: report('healthy', 1) }, items: [gmailItem] });
    expect(view && !view.unavailable && sourceSummary(view.sources)).toMatch(/Gmail 1$/);
  });

  it('shows Gmail — when an older server sends no gmail source', () => {
    const view = readUnifiedInboxView(base);
    expect(view && !view.unavailable && sourceSummary(view.sources)).toMatch(/Gmail —$/);
  });
});
