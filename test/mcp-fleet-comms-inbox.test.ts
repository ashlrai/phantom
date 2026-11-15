import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { UnifiedInbox } from '../src/core/comms/unified-inbox.js';
import { parseFleetCommsInboxArgs, readFleetCommsInbox } from '../src/mcp/fleet-comms-inbox.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const item: UnifiedInbox['items'][number] = {
  id: 'needs-you:fake', source: 'needs-you', kind: 'needs-you', severity: 'warn',
  priority: 'now', blocking: true, title: 'Fake message', detail: null,
  since: null, expiresAt: null, act: [],
};
const inbox: UnifiedInbox = {
  v: 1, generatedAt: '2026-01-01T00:00:00.000Z', total: 3, omitted: 1,
  sources: { 'needs-you': { state: 'healthy', pending: 3 }, imessage: { state: 'missing', pending: 0 },
    drafts: { state: 'missing', pending: 0 }, bus: { state: 'missing', pending: 0 } },
  items: [item, { ...item, id: 'needs-you:fake2' }],
};

describe('fleet comms inbox', () => {
  it('validates the optional limit and rejects unknown keys', () => {
    expect(parseFleetCommsInboxArgs({})).toEqual({ limit: 50 });
    for (const limit of [1, 200]) expect(parseFleetCommsInboxArgs({ limit })).toEqual({ limit });
    for (const limit of [0, 201, 1.5, '5', undefined]) expect(parseFleetCommsInboxArgs({ limit })).toBeNull();
    expect(parseFleetCommsInboxArgs({ extra: true })).toBeNull();
  });

  it('slices the shared inbox and computes omitted from total', async () => {
    let observed: unknown;
    const result = await readFleetCommsInbox({ limit: 1 }, { runsDir: '/fake', read: async options => { observed = options; return inbox; } });
    expect(observed).toEqual({ runsDir: '/fake' });
    expect(result).toEqual({ schema: 'comms.unified-inbox.v1', generatedAt: inbox.generatedAt,
      sources: inbox.sources, total: 3, omitted: 2, items: [item] });
  });

  it('returns unavailable when the reader throws', async () => {
    expect(await readFleetCommsInbox({ limit: 50 }, { read: async () => { throw new Error('fake'); } }))
      .toEqual({ schema: 'comms.unified-inbox.v1', unavailable: true, items: [] });
  });
});

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
it('lists and routes the tool through the fleet server', async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'comms-inbox-test', version: '1.0.0' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}),
    commsInbox: args => readFleetCommsInbox(args, { read: async () => inbox }) }).connect(st);
  await client.connect(ct);
  expect((await client.listTools()).tools.find(tool => tool.name === 'fleet_comms_inbox')).toBeDefined();
  const result = await client.callTool({ name: 'fleet_comms_inbox', arguments: { limit: 1 } });
  expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ items: [item], omitted: 2 });
  await expect(client.callTool({ name: 'fleet_comms_inbox', arguments: { limit: 0 } })).rejects.toThrow();
});
