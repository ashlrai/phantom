import { afterEach, expect, it, vi } from 'vitest';
import { mobileAgentBusPageQuery } from './agent-bus-page-query.js';
import { json, stubFetch } from './mobile.test-support.js';

afterEach(() => { document.head.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('narrows forward pages and retains the newest twenty', async () => {
  const { calls } = stubFetch({ 'GET /api/verse/agent-bus': (_body, call) => {
    const after = Number(new URL(call.url, 'http://fake.test').searchParams.get('after'));
    return { v: 1, status: 'ok', nextCursor: after < 40 ? after + 20 : 40,
      messages: after < 40 ? Array.from({ length: 20 }, (_, i) => ({ cursor: after + i + 1, receivedAt: 1,
        envelope: { id: `fake-${after + i}`, from: 'leader', to: 'leaders', priority: 'P0', ttl: 1000, body: { text: 'fake message' } } })) : [] };
  } });
  const page = await mobileAgentBusPageQuery.fetch();
  expect(calls[0].url).toBe('/api/verse/agent-bus?after=0&limit=20');
  expect(page?.messages.map(row => row.cursor)).toEqual(Array.from({ length: 20 }, (_, i) => i + 21));
});
it('returns null on remote 403 without swallowing local 403', async () => {
  stubFetch({ 'GET /api/verse/agent-bus': () => json({}, 403) });
  await expect(mobileAgentBusPageQuery.fetch()).rejects.toMatchObject({ status: 403 });
  document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
  // Avoid remote transport: apiGet delegates to it in remote mode.
  const remote = await import('../../../data/remote-session.js');
  vi.spyOn(remote, 'remoteApiGet').mockRejectedValue(new (await import('../../../data/client.js')).ApiError('Forbidden', 403, '/api/verse/agent-bus'));
  await expect(mobileAgentBusPageQuery.fetch()).resolves.toBeNull();
});

it('rejects an unrecognized page', async () => {
  stubFetch({ 'GET /api/verse/agent-bus': { v: 1, status: 'ok', messages: [{}], nextCursor: 1 } });
  await expect(mobileAgentBusPageQuery.fetch()).rejects.toMatchObject({ status: 502 });
});
it('returns null on a missing route', async () => {
  stubFetch({});
  await expect(mobileAgentBusPageQuery.fetch()).resolves.toBeNull();
});
