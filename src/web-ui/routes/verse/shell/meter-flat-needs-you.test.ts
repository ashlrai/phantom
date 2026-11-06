import { expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { deriveMeterFlatNeedsYou } from './meter-flat-needs-you.js';

const NOW = 1_000_000;
const body = (over: Record<string, unknown> = {}) => ({ kind: 'meter-flat', provider: 'fake-provider', running: 4,
  observedMinutes: 62, firstUsedPercent: 10, lastUsedPercent: 10, text: 'fake-provider meter flat 62 min while 4 jobs run', ...over });
const receipt = (cursor: number, b: unknown, over: { receivedAt?: number; ttl?: number } = {}): AgentBusReceipt => ({
  cursor, receivedAt: over.receivedAt ?? NOW - 1000,
  envelope: { id: `fake-${cursor}`, from: 'fleet', to: 'all', priority: 'P1', ttl: over.ttl ?? 60_000, body: b },
});

it('keeps the newest row per provider', () => {
  const items = deriveMeterFlatNeedsYou([
    receipt(1, body({ observedMinutes: 30, text: 'old' }), { receivedAt: NOW - 5000 }),
    receipt(2, body({ text: 'new' }), { receivedAt: NOW - 1000 }),
    receipt(3, body({ provider: 'other-provider', text: 'other' })),
  ], NOW);
  expect(items.map(item => [item.id, item.title])).toEqual([['meter-flat:fake-provider', 'new'], ['meter-flat:other-provider', 'other']]);
  expect(items[0]).toMatchObject({ target: 'fleet', open: { kind: 'pane', paneId: 'fleet-lanes' },
    nextStep: 'Check the lane is really spending, or hold it', detail: 'used 10% → 10% over 62 min' });
});

it('drops expired envelopes', () => {
  expect(deriveMeterFlatNeedsYou([receipt(1, body(), { receivedAt: NOW - 2000, ttl: 2000 })], NOW)).toEqual([]);
});

it('ignores other kinds and malformed bodies without throwing', () => {
  expect(deriveMeterFlatNeedsYou([
    receipt(1, body({ kind: 'something-else' })), receipt(2, 'text'), receipt(3, null), receipt(4, [1]),
    receipt(5, body({ provider: 7 })), receipt(6, body({ observedMinutes: 'x' })), receipt(7, body({ text: undefined })),
  ], NOW)).toEqual([]);
  expect(deriveMeterFlatNeedsYou(undefined, NOW)).toEqual([]);
});

it('is urgent from 60 minutes and attention below', () => {
  const sev = (m: number) => deriveMeterFlatNeedsYou([receipt(1, body({ observedMinutes: m }))], NOW)[0]?.severity;
  expect([sev(59), sev(60)]).toEqual(['attention', 'urgent']);
});

it('leaves out the percent clause when either value is null and trims the title', () => {
  const [a, b] = ['firstUsedPercent', 'lastUsedPercent'].map(key =>
    deriveMeterFlatNeedsYou([receipt(1, body({ [key]: null, text: 'x'.repeat(200) }))], NOW)[0]!);
  expect(a!.detail).toBe('over 62 min');
  expect(b!.detail).toBe('over 62 min');
  expect(a!.title).toHaveLength(120);
});
