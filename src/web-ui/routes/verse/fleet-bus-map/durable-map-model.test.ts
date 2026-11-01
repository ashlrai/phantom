import { expect, it } from 'vitest';
import { ApiError, apiGet } from '../../../data/client.js';
import { vi } from 'vitest';
import { agentBusMapQuery, narrowAgentBusMapPage, type AgentBusMapPage } from './agent-bus-map-queries.js';
import { buildDurableMap, durableHops, durableTotalsLine } from './durable-map-model.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));

const page: AgentBusMapPage = {
  v: 1, status: 'ok', nextCursor: 3, messages: [
    { cursor: 1, receivedAt: 60_000, envelope: { id: 'mason-desktop-one', from: 'mason', to: 'leaders', priority: 'P1', ttl: 1000, body: { kind: 'interjection', channel: 'example', text: 'hello' } } },
    { cursor: 2, receivedAt: 120_000, envelope: { id: 'mason-desktop-two', from: 'mason', to: 'leaders', priority: 'P2', ttl: 1000, body: { kind: 'interjection', channel: 'example', text: 'again' } } },
    { cursor: 3, receivedAt: 90_000, envelope: { id: 'reply', from: 'leader-opus', to: 'mason', priority: 'P3', ttl: 1000, body: { text: 'reply' } } },
  ],
};

it('maps interjections and replies into directed pairs and reports the newest receipt', () => {
  expect(durableHops(page)).toEqual([
    { id: 'mason-desktop-one', from: 'mason', to: 'leaders', at: 60_000, kind: 'interjection', inputTokens: null, outputTokens: null },
    { id: 'mason-desktop-two', from: 'mason', to: 'leaders', at: 120_000, kind: 'interjection', inputTokens: null, outputTokens: null },
    { id: 'reply', from: 'leader-opus', to: 'mason', at: 90_000, kind: 'P3', inputTokens: null, outputTokens: null },
  ]);
  const map = buildDurableMap(page);
  expect(map.pairs.map(({ from, to, hops }) => ({ from, to, hops }))).toEqual([
    { from: 'mason', to: 'leaders', hops: 2 }, { from: 'leader-opus', to: 'mason', hops: 1 },
  ]);
  expect(durableTotalsLine(map, 240_000)).toBe('Durable bus: 3 envelopes, 3 agents, last 2 min ago (mason → leaders 2).');
});

it('handles an empty page and opaque or non-string kinds', () => {
  const empty = buildDurableMap({ ...page, messages: [] });
  expect(empty.pairs).toEqual([]);
  expect(durableTotalsLine(empty, 0)).toBeNull();
  for (const body of [null, [], { kind: 1 }]) {
    const receipt = page.messages[0];
    expect(durableHops({ ...page, messages: [{ ...receipt, envelope: { ...receipt.envelope, body } }] })[0].kind).toBe('P1');
  }
});

it('checks page structure and refuses malformed successful responses', async () => {
  expect(narrowAgentBusMapPage(page)).toEqual(page);
  for (const invalid of [null, {}, { ...page, v: 2 }, { ...page, nextCursor: -1 },
    { ...page, messages: [{ ...page.messages[0], receivedAt: 'now' }] },
    { ...page, messages: [{ ...page.messages[0], envelope: { ...page.messages[0].envelope, from: 42 } }] }]) {
    expect(narrowAgentBusMapPage(invalid)).toBeNull();
  }
  vi.mocked(apiGet).mockResolvedValueOnce({ ...page, status: 'invalid' });
  await expect(agentBusMapQuery.fetch()).rejects.toThrow('Invalid durable bus page');
  for (const status of [404, 503]) {
    vi.mocked(apiGet).mockRejectedValueOnce(new ApiError('unavailable', status, '/api/verse/agent-bus'));
    await expect(agentBusMapQuery.fetch()).resolves.toBeNull();
  }
  vi.mocked(apiGet).mockRejectedValueOnce(new ApiError('denied', 401, '/api/verse/agent-bus'));
  await expect(agentBusMapQuery.fetch()).rejects.toMatchObject({ status: 401 });
});
