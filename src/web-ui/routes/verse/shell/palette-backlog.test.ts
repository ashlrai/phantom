import { describe, expect, it } from 'vitest';
import { backlogItemKeywords, backlogItemTitle, paletteBacklog } from './palette-backlog.js';
import { buildPaletteItems, paletteView } from './palette-model.js';

const row = (number: number, suggestedAction = 'recut', mergeStateStatus = 'DIRTY', isDraft = false) => ({
  number, title: 'bridge: RQ-PHX-FAKE31', job: 'RQ-PHX-FAKE31', suggestedAction, mergeStateStatus, isDraft,
});
const read = (items: unknown[]) => ({ v: 1, source: 'ok', repo: 'ashlrai/phantom', items });

describe('paletteBacklog', () => {
  it('orders by action then DIRTY, skips drafts and none, and caps at 20', () => {
    const items = paletteBacklog(read([
      row(4, 'merge'), row(3, 'wait'), row(2, 'refresh'), row(6, 'recut', 'BLOCKED'),
      row(1), row(7, 'none'), row(8, 'recut', 'DIRTY', true),
      ...Array.from({ length: 25 }, (_, i) => row(100 + i, 'merge', 'CLEAN')),
    ]));
    expect(items).toHaveLength(20);
    expect(items.slice(0, 5).map(item => item.number)).toEqual([1, 6, 2, 3, 4]);
    expect(items.some(item => item.number === 7 || item.number === 8)).toBe(false);
  });
  it('formats titles, URLs and searchable keywords', () => {
    const item = paletteBacklog(read([row(2461)]))[0]!;
    expect(backlogItemTitle(item)).toBe('PR #2461 · DIRTY · recut · bridge: RQ-PHX-FAKE31');
    expect(item.url).toBe('https://github.com/ashlrai/phantom/pull/2461');
    expect(backlogItemKeywords(item)).toEqual(['2461', 'rq-phx-fake31', 'dirty', 'recut', 'dirty', 'stuck', 'backlog']);
    const items = buildPaletteItems({ backlog: [item], needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
    for (const query of ['2461', 'rq-phx-fake31', 'dirty', 'stuck', 'backlog']) {
      expect(paletteView(items, query, [], 'mac').flat.some(candidate => candidate.key === 'backlog:2461')).toBe(true);
    }
    expect(items.find(candidate => candidate.key === 'backlog:summary')).toMatchObject({
      title: 'Merge backlog: 1 stuck (recut 1) · open Merges pane', payload: { kind: 'pane', paneId: 'fleet-merges' },
    });
  });
  it('rejects malformed envelopes and rows without producing unsafe URLs', () => {
    for (const value of [null, {}, { ...read([row(1)]), source: 'gh-failed' }, { ...read([row(1)]), repo: 'evil.test/x/y' }, { ...read([row(1)]), items: null }]) {
      expect(paletteBacklog(value)).toEqual([]);
    }
    expect(paletteBacklog(read([null, {}, { ...row(1), number: -1 }, { ...row(2), isDraft: 'false' }, { ...row(3), suggestedAction: 'constructor' }]))).toEqual([]);
  });
});
