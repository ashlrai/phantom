import { describe, expect, it } from 'vitest';
import { deriveFleetMergeNotifications as derive } from './deriveFleetMergeNotifications.js';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';

const now = Date.parse('2026-10-31T12:15:00Z');
const items = Array.from({ length: 6 }, (_, i) => ({ repo: 'ashlrai/bridge', number: i + 1, title: `Change ${i + 1}` }));
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date(now).toISOString(), sources: { merges: 'healthy' },
  mergesLastHour: { count: 6, items }, ...overrides,
});

describe('fleet merge notifications', () => {
  it('derives stable per-PR notifications and workbench pane links', () => {
    const data = snapshot({ mergesLastHour: { count: 2, items: items.slice(0, 2) } });
    const result = derive(data, now);
    expect(result.map((n) => n.id)).toEqual(['fleet-merge:ashlrai/bridge#1', 'fleet-merge:ashlrai/bridge#2']);
    expect(result[0]).toMatchObject({ category: 'fleet', severity: 'info', title: 'Merged #1',
      detail: 'bridge: Change 1', ts: data.generatedAt, actionLabel: 'Open merges' });
    for (const n of result) {
      const url = new URL(n.actionHref!);
      expect(url.pathname).toBe('/verse/');
      expect(parseDeepLink(url.search)).toEqual({ paneId: 'fleet-merges', sessionId: null });
    }
    expect(derive(data, now + 60_000).map((n) => n.id)).toEqual(result.map((n) => n.id));
  });

  it('rolls up more than five entries, using the count and the first three titles', () => {
    expect(derive(snapshot(), now)).toEqual([expect.objectContaining({
      id: 'fleet-merge:rollup:2026-10-31T12', title: '6 PRs merged in the last hour',
      detail: 'Change 1 · Change 2 · Change 3', actionLabel: 'Open merges',
    })]);
  });

  it.each(['missing', 'not-landed'])('ignores a %s merge source', (merges) => {
    expect(derive(snapshot({ sources: { merges } }), now)).toEqual([]);
  });

  it.each([null, undefined, {}, { generatedAt: 'bad' }, snapshot({ mergesLastHour: { count: 2, items: [null] } }),
    snapshot({ mergesLastHour: { count: -1, items } }), snapshot({ sources: { merges: 'unknown' } })])(
    'ignores malformed data: %j', (data) => expect(derive(data, now)).toEqual([]),
  );

  it('clamps individual and roll-up titles to 120 characters', () => {
    const title = 'x'.repeat(150);
    const longItems = items.map((item) => ({ ...item, title }));
    expect(derive(snapshot({ mergesLastHour: { count: 1, items: longItems.slice(0, 1) } }), now)[0]?.detail)
      .toBe(`bridge: ${'x'.repeat(119)}…`);
    expect(derive(snapshot({ mergesLastHour: { count: 6, items: longItems } }), now)[0]?.detail)
      .toBe(Array(3).fill(`${'x'.repeat(119)}…`).join(' · '));
  });
});
