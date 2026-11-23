/**
 * fleet_comms_thread: the owner thread read over the isolated fleet MCP
 * server — the same readOwnerThread projection `phm comms thread --json`,
 * the native `ashlr_comms_thread` tool and the owner-thread API serve.
 * fleet_comms_inbox lists the pending owner items and fleet_comms_status
 * reports counts and adapter states; this is the ordered read behind both
 * — what the owner said, what we answered, per-channel delivery receipts
 * and the awaiting-reply mark — with the CLI's channel/direction/since/
 * beforeAt/contains narrowing and unknown-stays-unknown honesty passed through
 * untouched.
 *
 * Hermetic: injected readers and crafted owner-thread fixtures under temp
 * runs dirs — never the real home, config, owner thread or pause/kill
 * stores.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  FLEET_COMMS_THREAD_LIMIT_DEFAULT, FLEET_COMMS_THREAD_LIMIT_MAX,
  parseFleetCommsThreadArgs, readFleetCommsThread,
} from '../src/mcp/fleet-comms-thread.js';
import { readOwnerThread, type OwnerThreadMessage, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';

const connections: Client[] = [];
const roots: string[] = [];
const TOOL = 'fleet_comms_thread';

afterEach(() => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const settings = emptyOwnerSettings();

const inbound = (seq: number, key: string, text: string, channel: OwnerThreadMessage['channel'] = 'desktop'): OwnerThreadMessage => ({
  seq, id: `m${seq}`, idempotencyKey: key, channel, senderId: 'local-owner',
  direction: 'inbound', at: '2026-11-18T10:00:00.000Z', text,
});

const outbound = (seq: number, key: string, text: string, replyTo?: string, channel: OwnerThreadMessage['channel'] = 'desktop'): OwnerThreadMessage => ({
  seq, id: `m${seq}`, idempotencyKey: key, channel, senderId: 'local-owner',
  direction: 'outbound', at: '2026-11-18T10:05:00.000Z', text,
  ...(replyTo === undefined ? {} : { replyTo }),
});

/** A temp runs dir; `corrupt` writes an unreadable owner-thread record. */
function runsDir(messages?: OwnerThreadMessage[], corrupt = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-comms-thread-'));
  roots.push(dir);
  const leader = join(dir, 'leader');
  mkdirSync(leader, { recursive: true });
  if (corrupt) writeFileSync(join(leader, 'owner-thread.json'), '{not json');
  else if (messages !== undefined) {
    writeFileSync(join(leader, 'owner-thread.json'), JSON.stringify({
      v: 1, threadId: 'owner', deliveries: {}, messages,
    }));
  }
  return dir;
}

function ownerOptions(dir: string, over: Partial<OwnerThreadOptions> = {}): OwnerThreadOptions {
  return {
    runsDir: dir,
    settings,
    now: () => 1_700_000_000_000,
    halted: false,
    paused: false,
    ...over,
  };
}

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'comms-thread-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_comms_thread argument parsing', () => {
  it('defaults limit to 50 and accepts the six thread filters', () => {
    expect(parseFleetCommsThreadArgs({})).toEqual({ limit: FLEET_COMMS_THREAD_LIMIT_DEFAULT });
    expect(parseFleetCommsThreadArgs({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseFleetCommsThreadArgs({ limit: FLEET_COMMS_THREAD_LIMIT_MAX })).toEqual({ limit: FLEET_COMMS_THREAD_LIMIT_MAX });
    expect(parseFleetCommsThreadArgs({ channel: 'telegram' })).toEqual({ limit: 50, filter: { channel: 'telegram' } });
    expect(parseFleetCommsThreadArgs({ direction: 'outbound' })).toEqual({ limit: 50, filter: { direction: 'outbound' } });
    expect(parseFleetCommsThreadArgs({ contains: 'deploy window' })).toEqual({ limit: 50, filter: { contains: 'deploy window' } });
    const withSince = parseFleetCommsThreadArgs({ since: '2h' });
    expect(withSince?.limit).toBe(50);
    expect(typeof withSince?.filter?.since).toBe('number');
    expect(withSince!.filter!.since!).toBeGreaterThan(0);
    const withBefore = parseFleetCommsThreadArgs({ beforeAt: '2026-11-18T00:00:00.000Z' });
    expect(withBefore).toEqual({ limit: 50, filter: { beforeAt: Date.parse('2026-11-18T00:00:00.000Z') } });
  });

  it('combines every filter into one narrowing', () => {
    expect(parseFleetCommsThreadArgs({
      limit: 10, channel: 'slack', direction: 'inbound', since: '2026-11-17T00:00:00.000Z', beforeAt: '2026-11-18T00:00:00.000Z', contains: 'ship it',
    })).toEqual({
      limit: 10,
      filter: { channel: 'slack', direction: 'inbound', since: Date.parse('2026-11-17T00:00:00.000Z'), beforeAt: Date.parse('2026-11-18T00:00:00.000Z'), contains: 'ship it' },
    });
  });

  it('rejects out-of-range limits, unknown keys and malformed filters before any read runs', () => {
    for (const bad of [
      { limit: 0 }, { limit: FLEET_COMMS_THREAD_LIMIT_MAX + 1 }, { limit: 1.5 }, { limit: '5' }, { limit: null },
      { channel: 'pager' }, { channel: 7 }, { direction: 'sideways' }, { direction: true },
      { since: 'bogus' }, { since: 1700000000000 }, { since: null },
      { beforeAt: 'bogus' }, { beforeAt: 1700000000000 }, { beforeAt: null }, { beforeAt: '-1' },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 42 },
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp/x' }, { configDir: '/tmp/x' },
      { extra: 1 }, { json: true },
    ]) expect(parseFleetCommsThreadArgs(bad)).toBeNull();
  });
});

describe('fleet_comms_thread reader', () => {
  it('spreads the shared projection beside the envelope metadata', async () => {
    const seen: unknown[][] = [];
    const view = {
      schema: 'comms.owner-thread.v1' as const, threadId: 'owner' as const,
      messages: [inbound(1, 'inbound-key-1', 'status check')],
      receipts: {}, awaitingReply: ['m1'],
    };
    const thread: typeof readOwnerThread = (...args: Parameters<typeof readOwnerThread>) => {
      seen.push(args as unknown[]);
      return view;
    };
    const result = await readFleetCommsThread(
      { limit: 25, filter: { channel: 'desktop' } },
      { options: ownerOptions(runsDir()), thread },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toBe(25);
    expect(seen[0]![2]).toEqual({ channel: 'desktop' });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'comms.owner-thread.v1', threadId: 'owner',
      awaitingReply: ['m1'],
    });
    expect((result as typeof view).messages).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports a throwing read as unavailable — never an invented empty thread', async () => {
    const result = await readFleetCommsThread(
      { limit: 50 },
      { options: ownerOptions(runsDir()), thread: (() => { throw new Error('config store unreadable'); }) as typeof readOwnerThread },
    );
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'owner-thread-unreadable',
    });
    expect('messages' in result).toBe(false);
    expect('awaitingReply' in result).toBe(false);
  });

  it('serves the real readOwnerThread projection: order, awaiting mark and filters', async () => {
    const dir = runsDir([
      inbound(1, 'inbound-key-1', 'status check'),
      outbound(2, 'outbound-key-1', 'on it', 'inbound-key-1'),
      inbound(3, 'inbound-key-2', 'also the deploy window?', 'telegram'),
    ]);
    const result = await readFleetCommsThread({ limit: 50 }, { options: ownerOptions(dir) });
    const view = result as ReturnType<typeof readOwnerThread> & { generatedAt: string };
    expect(view.schema).toBe('comms.owner-thread.v1');
    expect(view.messages.map(message => message.seq)).toEqual([1, 2, 3]);
    // The outbound cites inbound-key-1, so only the second inbound awaits a reply.
    expect(view.awaitingReply).toEqual(['m3']);
    expect(view.receipts).toEqual({});

    const inboundOnly = await readFleetCommsThread(
      { limit: 50, filter: { direction: 'inbound' } }, { options: ownerOptions(dir) });
    const inboundView = inboundOnly as ReturnType<typeof readOwnerThread>;
    expect(inboundView.messages.map(message => message.direction)).toEqual(['inbound', 'inbound']);
    expect(inboundView.awaitingReply).toEqual(['m3']);

    const telegram = await readFleetCommsThread(
      { limit: 50, filter: { channel: 'telegram' } }, { options: ownerOptions(dir) });
    const telegramView = telegram as ReturnType<typeof readOwnerThread>;
    expect(telegramView.messages.map(message => message.seq)).toEqual([3]);

    const needle = await readFleetCommsThread(
      { limit: 50, filter: { contains: 'DEPLOY WINDOW' } }, { options: ownerOptions(dir) });
    const needleView = needle as ReturnType<typeof readOwnerThread>;
    expect(needleView.messages.map(message => message.seq)).toEqual([3]);
    expect(needleView.awaitingReply).toEqual(['m3']);

    // beforeAt is the exclusive recorded-time ceiling: the 10:05 outbound drops, both 10:00 inbounds stay.
    const window = await readFleetCommsThread(
      { limit: 50, filter: { beforeAt: Date.parse('2026-11-18T10:03:00.000Z') } }, { options: ownerOptions(dir) });
    const windowView = window as ReturnType<typeof readOwnerThread>;
    expect(windowView.messages.map(message => message.seq)).toEqual([1, 3]);
    expect(windowView.awaitingReply).toEqual(['m3']);
  });

  it('keeps awaitingReply null and unavailable true on a corrupt thread — unknown stays unknown', async () => {
    const dir = runsDir(undefined, true);
    const result = await readFleetCommsThread({ limit: 50 }, { options: ownerOptions(dir) });
    const view = result as ReturnType<typeof readOwnerThread>;
    expect(view.schema).toBe('comms.owner-thread.v1');
    expect(view.unavailable).toBe(true);
    expect(view.messages).toEqual([]);
    expect(view.awaitingReply).toBeNull();
    expect(view.receipts).toEqual({});
  });

  it('reports a verified-empty thread for a missing record — real zeros, not unknown', async () => {
    const dir = runsDir();
    const result = await readFleetCommsThread({ limit: 50 }, { options: ownerOptions(dir) });
    const view = result as ReturnType<typeof readOwnerThread>;
    expect('unavailable' in view).toBe(false);
    expect(view.messages).toEqual([]);
    expect(view.awaitingReply).toEqual([]);
  });
});

describe('fleet_comms_thread MCP tool', () => {
  it('is advertised read-only beside fleet_comms_status with the filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === TOOL);
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('readOwnerThread');
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        channel: { type: 'string', enum: ['desktop', 'telegram', 'email', 'imessage', 'slack'] },
        direction: { type: 'string', enum: ['inbound', 'outbound'] },
        since: { type: 'string' },
        beforeAt: { type: 'string' },
        contains: { type: 'string', minLength: 1, maxLength: 512 },
      },
    });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ runsDir: '/tmp/x' }], [{ limit: 0 }], [{ limit: 201 }], [{ limit: '10' }],
    [{ channel: 'pager' }], [{ direction: 'sideways' }], [{ since: 'bogus' }], [{ beforeAt: 'bogus' }],
    [{ contains: '' }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const commsThread = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), commsThread });
    await expect(client.callTool({ name: TOOL, arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(commsThread).not.toHaveBeenCalled();
  });

  it('calls the injected reader with the parsed args and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'comms.owner-thread.v1', threadId: 'owner',
      messages: [], receipts: {}, awaitingReply: [],
    };
    const commsThread = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), commsThread });
    const { parsed } = await call(client, { limit: 5, channel: 'telegram', contains: 'deploy' });
    expect(commsThread).toHaveBeenCalledWith({
      limit: 5, filter: { channel: 'telegram', contains: 'deploy' },
    });
    expect(parsed).toEqual(payload);
  });

  it('defaults to limit 50 with no filter when arguments are omitted', async () => {
    const commsThread = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), commsThread });
    const { parsed } = await call(client);
    expect(commsThread).toHaveBeenCalledWith({ limit: 50 });
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      commsThread: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: TOOL, arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_comms_thread` \|/m);
  });
});
