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

  it('validates and normalizes the unified-inbox filter dimensions', () => {
    expect(parseFleetCommsInboxArgs({ source: 'bus' }))
      .toEqual({ limit: 50, filter: { source: 'bus' } });
    expect(parseFleetCommsInboxArgs({ kind: 'bus-handoff' }))
      .toEqual({ limit: 50, filter: { kind: 'bus-handoff' } });
    expect(parseFleetCommsInboxArgs({ severity: 'high', blocking: true }))
      .toEqual({ limit: 50, filter: { severity: 'high', blocking: true } });
    expect(parseFleetCommsInboxArgs({ blocking: false }))
      .toEqual({ limit: 50, filter: { blocking: false } });
    expect(parseFleetCommsInboxArgs({ job: 'RQ-ABC-1' }))
      .toEqual({ limit: 50, filter: { job: 'RQ-ABC-1' } });
    expect(parseFleetCommsInboxArgs({ since: '1735689600000' }))
      .toEqual({ limit: 50, filter: { since: 1735689600000 } });
    expect(parseFleetCommsInboxArgs({ before: '1735689600000' }))
      .toEqual({ limit: 50, filter: { before: 1735689600000 } });
    expect(parseFleetCommsInboxArgs({ contains: 'fake' }))
      .toEqual({ limit: 50, filter: { contains: 'fake' } });
    expect(parseFleetCommsInboxArgs({ source: 'bus', kind: 'bus-work', severity: 'warn', blocking: true, job: 'J1', since: '2h', before: '1h', contains: 'x', limit: 10 }))
      .toEqual({ limit: 10, filter: { source: 'bus', kind: 'bus-work', severity: 'warn', blocking: true, job: 'J1', since: expect.any(Number), before: expect.any(Number), contains: 'x' } });
  });

  it('rejects malformed filter values', () => {
    for (const bad of [
      { source: 'not-a-source' }, { source: 5 }, { kind: 'not-a-kind' }, { kind: 'BUS-WORK' }, { kind: 5 },
      { severity: 'critical' }, { severity: true },
      { blocking: 'yes' }, { blocking: 1 }, { job: '' }, { job: 'has space' }, { job: 'x'.repeat(129) },
      { since: 'not-a-time' }, { since: '' }, { since: 1735689600000 },
      { before: 'not-a-time' }, { before: '' }, { before: 1735689600000 }, { before: true },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 42 },
    ]) expect(parseFleetCommsInboxArgs(bad)).toBeNull();
  });

  it('slices the shared inbox and computes omitted from total', async () => {
    let observed: unknown;
    const result = await readFleetCommsInbox({ limit: 1 }, { runsDir: '/fake', read: async options => { observed = options; return inbox; } });
    expect(observed).toEqual({ runsDir: '/fake' });
    expect(result).toEqual({ schema: 'comms.unified-inbox.v1', generatedAt: inbox.generatedAt,
      sources: inbox.sources, total: 3, omitted: 2, items: [item] });
  });

  it('passes an applied filter to the projection and echoes it on the result', async () => {
    let observed: unknown;
    const filtered: UnifiedInbox = { ...inbox, total: 1, filter: { source: 'bus' }, items: [item] };
    const result = await readFleetCommsInbox({ limit: 50, filter: { source: 'bus' } },
      { runsDir: '/fake', read: async options => { observed = options; return filtered; } });
    expect(observed).toEqual({ runsDir: '/fake', filter: { source: 'bus' } });
    expect(result).toMatchObject({ schema: 'comms.unified-inbox.v1', total: 1, omitted: 0,
      items: [item], filter: { source: 'bus' } });
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
    commsInbox: args => readFleetCommsInbox(args, { read: async options =>
      options.filter === undefined ? inbox : { ...inbox, total: 1, filter: options.filter, items: [item] } }) }).connect(st);
  await client.connect(ct);
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'fleet_comms_inbox');
  expect(tool).toBeDefined();
  expect(Object.keys((tool!.inputSchema as { properties: Record<string, unknown> }).properties))
    .toEqual(['limit', 'source', 'kind', 'severity', 'blocking', 'job', 'since', 'before', 'contains']);
  const result = await client.callTool({ name: 'fleet_comms_inbox', arguments: { limit: 1 } });
  expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ items: [item], omitted: 2 });
  const filtered = await client.callTool({ name: 'fleet_comms_inbox',
    arguments: { source: 'bus', kind: 'bus-work', contains: 'fake' } });
  expect(JSON.parse((filtered.content as Array<{ text: string }>)[0].text))
    .toMatchObject({ total: 1, filter: { source: 'bus', kind: 'bus-work', contains: 'fake' } });
  await expect(client.callTool({ name: 'fleet_comms_inbox', arguments: { limit: 0 } })).rejects.toThrow();
  await expect(client.callTool({ name: 'fleet_comms_inbox', arguments: { source: 'bogus' } })).rejects.toThrow();
});
