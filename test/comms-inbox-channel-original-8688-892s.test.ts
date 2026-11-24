import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readUnifiedInbox } from '../src/core/comms/unified-inbox.js';
import { parseUnifiedInboxQuery } from '../src/core/comms/unified-inbox-query.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { createCommsInboxApi, VERSE_COMMS_INBOX_PATH } from '../src/core/verse/comms-inbox-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { parseFleetCommsInboxArgs, readFleetCommsInbox } from '../src/mcp/fleet-comms-inbox.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('filters real pending work using only proven recipient channels and keeps source totals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-892-')); roots.push(root);
  const runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
  for (const [id, to] of [['one', 'group:eng:general'], ['two', 'group:ops:alerts'], ['plain', 'agent:eng']]) {
    expect(appendBusInbox({ id: id!, from: 'agent:peer', to: to!, priority: 'P2', ttl: 60000,
      body: { kind: 'work', text: `fake ${id}` } }, { root: busRoot }).status).toBe('posted');
  }
  const opts = { runsDir, busRoot, readRequests: () => ({ status: 'missing' as const, requests: [] }) };
  const all = await readUnifiedInbox(opts);
  const eng = await readUnifiedInbox({ ...opts, filter: { channel: 'eng', source: 'bus', contains: 'one' } });
  expect(eng.items.map(item => [item.id, item.channels])).toEqual([['bus:one', ['eng']]]);
  expect(eng.sources).toEqual(all.sources);
  expect(all.items.find(item => item.id === 'bus:plain')).not.toHaveProperty('channels');
  expect((await readUnifiedInbox({ ...opts, filter: { channel: 'ops' } })).items.map(item => item.id)).toEqual(['bus:two']);
  expect((await readUnifiedInbox({ ...opts, filter: { channel: 'eng', source: 'mailbox' } })).total).toBe(0);
});

it('validates and passes channel through CLI, query, API and MCP catalog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-892-')); roots.push(root);
  const runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const command = createCommsInboxCommand({ runsDir, busRoot });
  expect(await command(['--channel', 'eng', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).filter).toEqual({ channel: 'eng' });
  expect(await command(['--channel', 'Bad', '--json'])).toBe(2);
  expect(parseUnifiedInboxQuery(new URLSearchParams('channel=eng'))).toMatchObject({ ok: true, query: { filter: { channel: 'eng' } } });
  expect(parseUnifiedInboxQuery(new URLSearchParams('channel=Bad')).ok).toBe(false);
  expect(parseFleetCommsInboxArgs({ channel: 'eng' })).toEqual({ limit: 50, filter: { channel: 'eng' } });
  expect(parseFleetCommsInboxArgs({ channel: 'Bad' })).toBeNull();
  const api = createCommsInboxApi({ runsDir, busRoot });
  for (const [channel, expected] of [['eng', 200], ['Bad', 400]] as const) {
    let status = 0; let body = '';
    const req = Object.assign(new PassThrough(), { url: `${VERSE_COMMS_INBOX_PATH}?channel=${channel}`, method: 'GET' }) as IncomingMessage;
    const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; } } as unknown as ServerResponse;
    await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, VERSE_COMMS_INBOX_PATH, 'GET');
    expect(status).toBe(expected);
    if (status === 200) expect(JSON.parse(body).filter).toEqual({ channel: 'eng' });
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'channel-test', version: '1' });
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), commsInbox: args => readFleetCommsInbox(args, { runsDir, busRoot }) }).connect(st);
  await client.connect(ct);
  try {
    const tool = (await client.listTools()).tools.find(row => row.name === 'fleet_comms_inbox');
    expect(tool?.inputSchema.properties).toHaveProperty('channel');
    const result = await client.callTool({ name: 'fleet_comms_inbox', arguments: { channel: 'eng' } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).filter).toEqual({ channel: 'eng' });
    await expect(client.callTool({ name: 'fleet_comms_inbox', arguments: { channel: 'Bad' } })).rejects.toThrow();
  } finally { await client.close(); }
});

it('deduplicates and sorts thread citations and ignores malformed recipients', async () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-892-')); roots.push(root);
  const result = await readUnifiedInbox({ runsDir: join(root, 'runs'), busRoot: join(root, 'bus'),
    readRequests: () => ({ status: 'missing', requests: [] }),
    readConversations: () => ({ schema: 'agents.conversations.v1', version: 1, generatedAt: '2026-01-01T00:00:00Z',
      source: 'available', matched: 1, waiting: 1, skipped: 0, conversations: [{
        id: 'fake-thread', state: 'waiting', subject: 'fake', jobs: [], messageCount: 6,
        waiting: { on: 'agent:peer', since: '2026-01-01T00:00:00Z', ms: 1 },
        messages: ['group:ops:alerts', 'group:eng:general', 'group:ops:other', 'group:bad name:topic', 'group:missing', 'group:empty:']
          .map(to => ({ id: 'fake', from: 'agent:peer', to })),
      }] } as unknown as ReturnType<NonNullable<import('../src/core/comms/unified-inbox.js').UnifiedInboxOptions['readConversations']>>),
    readMailbox: () => ({ source: 'unavailable', messages: [], matched: null }),
    filter: { channel: 'eng', source: 'conversations' },
  });
  expect(result.items[0]?.channels).toEqual(['eng', 'ops']);
  expect(result.sources.mailbox).toEqual({ state: 'unavailable', pending: null });
});
