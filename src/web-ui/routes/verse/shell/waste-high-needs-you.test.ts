import { expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { deriveWasteHighNeedsYou } from './waste-high-needs-you.js';

const NOW = 1_000_000;
const body = (over: Record<string, unknown> = {}) => ({ kind: 'waste-high', lane: 'fake-lane', projectedUnusedPct: 42,
  hoursToReset: 9.5, text: 'fake-lane: 42% projected unused at reset in 9.5 h', ...over });
const receipt = (cursor: number, b: unknown, over: { receivedAt?: number; ttl?: number } = {}): AgentBusReceipt => ({
  cursor, receivedAt: over.receivedAt ?? NOW - 1000,
  envelope: { id: `fake-${cursor}`, from: 'fleet', to: 'all', priority: 'P1', ttl: over.ttl ?? 60_000, body: b },
});

it('turns a valid envelope into one Supply row', () => {
  const items = deriveWasteHighNeedsYou([receipt(1, body())], NOW);
  expect(items).toEqual([{ id: 'waste-high:fake-lane', severity: 'attention', title: 'fake-lane: 42% projected unused at reset in 9.5 h',
    detail: '42% unused at reset · 9.5 h left', nextStep: 'Add jobs on this lane or raise its target',
    target: 'fleet', open: { kind: 'pane', paneId: 'fleet-supply' } }]);
});

it('is urgent at 6 hours or less', () => {
  const sev = (h: number) => deriveWasteHighNeedsYou([receipt(1, body({ hoursToReset: h }))], NOW)[0]?.severity;
  expect([sev(6.5), sev(6), sev(1)]).toEqual(['attention', 'urgent', 'urgent']);
});

it('keeps the newest row per lane', () => {
  const items = deriveWasteHighNeedsYou([
    receipt(1, body({ text: 'old' }), { receivedAt: NOW - 5000 }),
    receipt(2, body({ text: 'new' }), { receivedAt: NOW - 1000 }),
    receipt(3, body({ lane: 'other-lane', text: 'other' })),
  ], NOW);
  expect(items.map(item => [item.id, item.title])).toEqual([['waste-high:fake-lane', 'new'], ['waste-high:other-lane', 'other']]);
});

it('skips expired, wrong-kind, malformed and non-finite envelopes', () => {
  expect(deriveWasteHighNeedsYou([
    receipt(1, body(), { receivedAt: NOW - 2000, ttl: 2000 }),
    receipt(2, body({ kind: 'meter-flat' })), receipt(3, [body()]), receipt(4, 'text'), receipt(5, null),
    receipt(6, body({ lane: undefined })), receipt(7, body({ lane: '' })), receipt(8, body({ text: 3 })),
    receipt(9, body({ projectedUnusedPct: Number.NaN })), receipt(10, body({ hoursToReset: Infinity })),
    receipt(11, body({ projectedUnusedPct: '42' })),
  ], NOW)).toEqual([]);
  expect(deriveWasteHighNeedsYou(undefined, NOW)).toEqual([]);
});

it('adds the suggested target only when finite', () => {
  const detail = (v: unknown) => deriveWasteHighNeedsYou([receipt(1, body({ recommendedTarget: v }))], NOW)[0]!.detail;
  expect(detail(8)).toBe('42% unused at reset · 9.5 h left · suggested target 8');
  expect([detail('8'), detail(null), detail(Number.NaN)]).toEqual(Array(3).fill('42% unused at reset · 9.5 h left'));
});

it('clips the title to 120 characters', () => {
  expect(deriveWasteHighNeedsYou([receipt(1, body({ text: 'x'.repeat(200) }))], NOW)[0]!.title).toHaveLength(120);
});
