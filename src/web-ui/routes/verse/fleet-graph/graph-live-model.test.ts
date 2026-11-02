import { expect, it } from 'vitest';
import { liveHeadline, liveIssuesText, liveNodeRows } from './graph-live-model.js';
import { narrowGraphLive, type GraphLiveData, type GraphLiveState } from './graph-live-queries.js';

const now = new Date(2026, 10, 2, 19, 41).getTime();
const node = (id: string, state: GraphLiveState, resetsAtMs: number | null = null, readingAgeMs: number | null = null) => ({
  id, kind: 'seat', live: { state, usedPercent: null, resetsAtMs, readingAgeMs, stale: state === 'stale', reasons: [] },
});
const data: GraphLiveData = { v: 1, live: { complete: false, nodes: [
  node('ready', 'ready'), node('stale', 'stale'), node('limited', 'limited', now + 90 * 60_000, 90 * 60_000),
  node('exhausted-z', 'exhausted', now + 30 * 60 * 60_000), node('exhausted-a', 'exhausted'),
  node('unknown', 'unknown'), node('held', 'held'), node('untracked', 'untracked'),
], issues: [{ code: 'quota-ledger-missing', nodeIds: [] }, { code: 'seat-unread', nodeIds: ['codex-personal'] }] } };

it('orders all states worst first, then ids, and formats null and dated readings', () => {
  const rows = liveNodeRows(data, now);
  expect(rows.map(row => row.id)).toEqual(['exhausted-a', 'exhausted-z', 'held', 'stale', 'unknown', 'limited', 'ready', 'untracked']);
  expect(rows[0]).toMatchObject({ usedText: 'unmeasured', resetText: 'reset unknown', ageText: 'no dated reading' });
  expect(rows[1]?.resetText).toBe('resets Nov 4 01:41');
  expect(rows[5]).toMatchObject({ resetText: 'resets in 1 h 30 min', ageText: 'read 1 h 30 min ago' });
  const later = { v: 1 as const, live: { nodes: [node('seat', 'ready', now + 130 * 60_000, 3 * 60_000)] } };
  expect(liveNodeRows(later, now)[0]).toMatchObject({ resetText: 'resets in 2 h 10 min', ageText: 'read 3 min ago' });
});

it('counts nonzero buckets and reports incomplete data and issues', () => {
  expect(liveHeadline(data)).toBe('8 nodes · 1 ready · 1 limited · 2 exhausted · 1 held · 1 stale · 1 unknown · 1 untracked · incomplete');
  expect(liveIssuesText(data)).toEqual(['quota ledger missing', 'seats unread: codex-personal']);
  expect(liveIssuesText({ v: 1, live: { nodes: [] } })).toBeNull();
});

it('rejects invalid wire data and preserves actual zero measurements', () => {
  expect(narrowGraphLive(data)).toEqual(data);
  expect(narrowGraphLive({ ...data, v: 2 })).toBeNull();
  expect(narrowGraphLive({ v: 1, live: { nodes: [{ ...data.live.nodes[0], live: { ...data.live.nodes[0]!.live, state: 'healthy' } }] } })).toBeNull();
  expect(narrowGraphLive({ v: 1, live: { nodes: [{ ...data.live.nodes[0], live: { ...data.live.nodes[0]!.live, usedPercent: '0' } }] } })).toBeNull();
  const measured = { v: 1 as const, live: { nodes: [{ ...data.live.nodes[0]!, live: { ...data.live.nodes[0]!.live, usedPercent: 0 } }] } };
  expect(liveNodeRows(measured, now)[0]?.usedText).toBe('0% used');
});
