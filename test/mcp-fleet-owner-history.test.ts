/**
 * fleet_owner_history: the archived owner-thread read over the isolated
 * fleet MCP server — the same readOwnerThreadHistory projection
 * `phm fleet owner-history` serves. fleet_comms_thread reads only the
 * live thread window; once rotation moves the oldest messages into
 * owner-thread-archive files beside the live record, this is the only
 * MCP read that pages them back — seq paging with `before`, bounded
 * pages with `limit`, the shared channel/direction/since/contains view
 * slice `fleet_comms_thread` exposes, archive/skipped counts kept
 * honest and message text scrubbed on read, all through the shared
 * projection so the CLI and MCP surfaces can never diverge.
 *
 * Hermetic: injected readers and crafted owner-thread archive fixtures
 * under temp runs dirs — never the real home, config, owner thread or
 * pause/kill stores.
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
  FLEET_OWNER_HISTORY_LIMIT_DEFAULT, FLEET_OWNER_HISTORY_LIMIT_MAX,
  parseFleetOwnerHistoryArgs, readFleetOwnerHistory,
} from '../src/mcp/fleet-owner-history.js';
import { readOwnerThreadHistory } from '../src/core/comms/owner-thread-archive.js';
import type { OwnerThreadMessage } from '../src/core/comms/owner-thread.js';

const connections: Client[] = [];
const roots: string[] = [];
const TOOL = 'fleet_owner_history';

afterEach(() => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const message = (seq: number, text = `fake message ${seq}`): OwnerThreadMessage => ({
  seq, id: `m${seq}`, idempotencyKey: `message-${seq}`, channel: 'desktop',
  senderId: 'local-owner', direction: 'inbound', at: '2026-01-01T00:00:00.000Z', text,
});

/** A temp runs dir whose leader/ holds the given archive records. */
function runsDir(archives: Array<{ first: number; last: number; messages: unknown[] } | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-owner-history-'));
  roots.push(dir);
  const leader = join(dir, 'leader');
  mkdirSync(leader, { recursive: true });
  for (const entry of archives) {
    if (typeof entry === 'string') {
      writeFileSync(join(leader, entry), '{not json');
      continue;
    }
    writeFileSync(
      join(leader, `owner-thread-archive-${entry.first}-${entry.last}.json`),
      JSON.stringify({ v: 1, threadId: 'owner', messages: entry.messages }),
      { mode: 0o600 },
    );
  }
  return dir;
}

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) , ...extra });
  const client = new Client({ name: 'owner-history-test', version: '1.0.0' });
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

describe('fleet_owner_history argument parsing', () => {
  it('defaults limit to 50 and accepts before plus limit', () => {
    expect(parseFleetOwnerHistoryArgs({})).toEqual({ limit: FLEET_OWNER_HISTORY_LIMIT_DEFAULT });
    expect(parseFleetOwnerHistoryArgs({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseFleetOwnerHistoryArgs({ limit: FLEET_OWNER_HISTORY_LIMIT_MAX })).toEqual({ limit: FLEET_OWNER_HISTORY_LIMIT_MAX });
    expect(parseFleetOwnerHistoryArgs({ before: 42 })).toEqual({ limit: 50, before: 42 });
    expect(parseFleetOwnerHistoryArgs({ before: 7, limit: 10 })).toEqual({ limit: 10, before: 7 });
  });

  it('accepts the shared view slice and rejects malformed values before any read runs', () => {
    expect(parseFleetOwnerHistoryArgs({ channel: 'telegram' })).toEqual({ limit: 50, filter: { channel: 'telegram' } });
    expect(parseFleetOwnerHistoryArgs({ direction: 'inbound' })).toEqual({ limit: 50, filter: { direction: 'inbound' } });
    expect(parseFleetOwnerHistoryArgs({ direction: 'outbound', limit: 10 })).toEqual({ limit: 10, filter: { direction: 'outbound' } });
    expect(parseFleetOwnerHistoryArgs({ since: '2026-01-01T00:00:00Z' })).toEqual({ limit: 50, filter: { since: Date.parse('2026-01-01T00:00:00Z') } });
    expect(parseFleetOwnerHistoryArgs({ since: '1700000000000' })).toEqual({ limit: 50, filter: { since: 1700000000000 } });
    expect(parseFleetOwnerHistoryArgs({ contains: 'deploy fix' })).toEqual({ limit: 50, filter: { contains: 'deploy fix' } });
    expect(parseFleetOwnerHistoryArgs({ before: 9, channel: 'slack', contains: 'x' })).toEqual({ limit: 50, before: 9, filter: { channel: 'slack', contains: 'x' } });
    for (const bad of [
      { channel: 'sms' }, { channel: 5 }, { channel: null },
      { direction: 'sideways' }, { direction: 1 },
      { since: 'bogus' }, { since: 5 }, { since: '-1' }, { since: null },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 5 },
    ]) expect(parseFleetOwnerHistoryArgs(bad)).toBeNull();
  });

  it('rejects out-of-range limits, bad cursors, unknown keys and caller paths before any read runs', () => {
    for (const bad of [
      { limit: 0 }, { limit: FLEET_OWNER_HISTORY_LIMIT_MAX + 1 }, { limit: 1.5 }, { limit: '5' }, { limit: null },
      { before: 0 }, { before: -3 }, { before: 1.5 }, { before: '5' }, { before: null },
      { before: Number.MAX_SAFE_INTEGER + 1 }, { before: Number.NaN },
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp/x' }, { configDir: '/tmp/x' },
      { extra: 1 }, { json: true },
    ]) expect(parseFleetOwnerHistoryArgs(bad)).toBeNull();
  });
});

describe('fleet_owner_history reader', () => {
  it('spreads the shared projection beside the envelope metadata and forwards the page', async () => {
    const seen: unknown[][] = [];
    const view = {
      schema: 'comms.owner-thread-history.v1' as const,
      messages: [message(1)], archives: 2, skipped: 1,
    };
    const history: typeof readOwnerThreadHistory = (...args: Parameters<typeof readOwnerThreadHistory>) => {
      seen.push(args as unknown[]);
      return view;
    };
    const result = await readFleetOwnerHistory(
      { limit: 25, before: 40 },
      { runsDir: '/server-owned', history },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toEqual({ runsDir: '/server-owned' });
    expect(seen[0]![1]).toEqual({ before: 40, limit: 25 });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'comms.owner-thread-history.v1', archives: 2, skipped: 1,
    });
    expect((result as typeof view).messages).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('forwards the view slice to the shared read as page fields', async () => {
    const seen: unknown[][] = [];
    const history: typeof readOwnerThreadHistory = (...args: Parameters<typeof readOwnerThreadHistory>) => {
      seen.push(args as unknown[]);
      return { schema: 'comms.owner-thread-history.v1' as const, messages: [], archives: 0, skipped: 0 };
    };
    await readFleetOwnerHistory(
      { limit: 10, before: 30, filter: { channel: 'telegram', contains: 'deploy' } },
      { runsDir: '/server-owned', history },
    );
    expect(seen[0]![1]).toEqual({ before: 30, limit: 10, channel: 'telegram', contains: 'deploy' });
  });

  it('reports a throwing read as unavailable — never an invented empty history', async () => {
    const result = await readFleetOwnerHistory(
      { limit: 50 },
      { runsDir: '/server-owned', history: (() => { throw new Error('archive store unreadable'); }) as typeof readOwnerThreadHistory },
    );
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'owner-thread-history-unreadable',
    });
    expect('messages' in result).toBe(false);
    expect('archives' in result).toBe(false);
  });

  it('serves the real readOwnerThreadHistory projection: paging, bounds, dedupe and scrubbing', async () => {
    const dir = runsDir([
      { first: 1, last: 2, messages: [message(1), message(2)] },
      { first: 3, last: 4, messages: [message(3), message(4, `token=${'a'.repeat(30)}`)] },
      { first: 5, last: 6, messages: [message(5), message(6)] },
      'owner-thread-archive-7-7.json',
    ]);
    const newest = await readFleetOwnerHistory({ limit: 3 }, { runsDir: dir });
    const newestView = newest as ReturnType<typeof readOwnerThreadHistory>;
    expect(newestView.schema).toBe('comms.owner-thread-history.v1');
    expect(newestView.messages.map(m => m.seq)).toEqual([4, 5, 6]);
    expect(newestView.archives).toBe(4);
    expect(newestView.skipped).toBe(1);
    expect(newestView.messages[0]!.text).toContain('[REDACTED]');

    const older = await readFleetOwnerHistory({ before: 5, limit: 3 }, { runsDir: dir });
    const olderView = older as ReturnType<typeof readOwnerThreadHistory>;
    expect(olderView.messages.map(m => m.seq)).toEqual([2, 3, 4]);

    const oldest = await readFleetOwnerHistory({ before: 3, limit: 2 }, { runsDir: dir });
    expect((oldest as ReturnType<typeof readOwnerThreadHistory>).messages.map(m => m.seq)).toEqual([1, 2]);
  });

  it('applies the shared view slice to the real archived projection', async () => {
    const dir = runsDir([{
      first: 1, last: 3,
      messages: [
        { ...message(1), channel: 'telegram', direction: 'outbound', text: 'ship it' },
        message(2),
        { ...message(3), channel: 'email', at: '2026-01-03T00:00:00.000Z', text: 'please review the fix' },
      ],
    }]);
    const seqs = async (filter: NonNullable<Parameters<typeof readFleetOwnerHistory>[0]['filter']>) =>
      ((await readFleetOwnerHistory({ limit: 50, filter }, { runsDir: dir })) as ReturnType<typeof readOwnerThreadHistory>).messages.map(m => m.seq);
    expect(await seqs({ channel: 'telegram' })).toEqual([1]);
    expect(await seqs({ direction: 'outbound' })).toEqual([1]);
    expect(await seqs({ since: Date.parse('2026-01-02T00:00:00.000Z') })).toEqual([3]);
    expect(await seqs({ contains: 'review' })).toEqual([3]);
    expect(await seqs({ channel: 'slack' })).toEqual([]);
  });

  it('reports a verified-empty history for a missing leader dir — real zeros, not unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-owner-history-empty-'));
    roots.push(dir);
    const result = await readFleetOwnerHistory({ limit: 50 }, { runsDir: dir });
    const view = result as ReturnType<typeof readOwnerThreadHistory>;
    expect('status' in result).toBe(false);
    expect(view.messages).toEqual([]);
    expect(view.archives).toBe(0);
    expect(view.skipped).toBe(0);
  });
});

describe('fleet_owner_history MCP tool', () => {
  it('is advertised read-only beside fleet_comms_thread with the page schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === TOOL);
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('readOwnerThreadHistory');
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: {
        before: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        channel: { type: 'string' },
        direction: { type: 'string', enum: ['inbound', 'outbound'] },
        since: { type: 'string' },
        contains: { type: 'string', minLength: 1, maxLength: 512 },
      },
    });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ runsDir: '/tmp/x' }], [{ before: 0 }], [{ before: 1.5 }], [{ before: '9' }],
    [{ limit: 0 }], [{ limit: 501 }], [{ limit: '10' }],
    [{ channel: 'sms' }], [{ channel: 5 }], [{ direction: 'sideways' }],
    [{ since: 'bogus' }], [{ since: 5 }], [{ contains: '' }], [{ contains: 'x'.repeat(513) }],
    [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const ownerHistory = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), ownerHistory });
    await expect(client.callTool({ name: TOOL, arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(ownerHistory).not.toHaveBeenCalled();
  });

  it('calls the injected reader with the parsed args and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'comms.owner-thread-history.v1',
      messages: [], archives: 0, skipped: 0,
    };
    const ownerHistory = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), ownerHistory });
    const { parsed } = await call(client, { before: 12, limit: 5 });
    expect(ownerHistory).toHaveBeenCalledWith({ limit: 5, before: 12 });
    expect(parsed).toEqual(payload);
  });

  it('passes the view slice through to the reader as a filter', async () => {
    const ownerHistory = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), ownerHistory });
    await call(client, { channel: 'telegram', direction: 'inbound', since: '2026-01-01T00:00:00Z', contains: 'deploy' });
    expect(ownerHistory).toHaveBeenCalledWith({
      limit: 50,
      filter: { channel: 'telegram', direction: 'inbound', since: Date.parse('2026-01-01T00:00:00Z'), contains: 'deploy' },
    });
  });

  it('defaults to limit 50 with no cursor when arguments are omitted', async () => {
    const ownerHistory = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), ownerHistory });
    const { parsed } = await call(client);
    expect(ownerHistory).toHaveBeenCalledWith({ limit: 50 });
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      ownerHistory: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: TOOL, arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_owner_history` \|/m);
  });
});
