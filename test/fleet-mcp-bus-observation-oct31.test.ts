/**
 * RQ-PHX-BUSOBSMCPOCT31H — fleet_bus_hops: read-only observation of the real
 * cross-agent bus hop log through the existing fleet MCP server. The tool
 * returns validated hop metadata (id/from/to, nullable token usage) only:
 * never bodies, extra fields, lifecycle claims, or invented activity.
 *
 * Hermetic: isolated ASHLR_HOME fixture dirs, in-memory MCP transports, no
 * daemon, transport, or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  appendBusHop, BUS_HOPLOG_READ_BYTES, busHoplogPath, readBusHoplogTail,
} from '../src/core/fleet/bus-hoplog.js';
import {
  createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders,
} from '../src/mcp/fleet-server.js';
import { readFleetBusHops } from '../src/mcp/fleet.js';

let root: string;
const connections: Client[] = [];
const ids = { id: 'hop-1', from: 'codex-cmp', to: 'RQ-EVENTD' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-obs-'));
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Real protocol round trip; bus defaults to the real hoplog reader. */
async function connect(readers: FleetReaders = {
  status: async () => ({ pending: 2 }),
  loop: async limit => ({ limit }),
  bus: readFleetBusHops,
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'bus-obs-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callBus(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_hops', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

function writeRawLog(text: string, mode = 0o600): void {
  mkdirSync(dirname(busHoplogPath()), { recursive: true, mode: 0o700 });
  writeFileSync(busHoplogPath(), text, { mode });
}

const row = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, from: 'codex-cmp', to: 'RQ-EVENTD', inputTokens: null, outputTokens: null, ...extra });

describe('fleet_bus_hops MCP tool', () => {
  it('is listed beside the existing tools with a bounded read-only schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['fleet_status', 'fleet_loop', 'fleet_bus_hops']);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_hops');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.properties?.['limit']).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
  });

  it('distinguishes a missing log from an empty one without inventing activity', async () => {
    const client = await connect();
    const missing = await callBus(client);
    expect(missing.parsed).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'missing', logBytes: null, hops: null,
      returnedHops: null, skippedRows: null, truncated: null, limit: 20,
    });
    writeRawLog('');
    const empty = await callBus(client);
    expect(empty.parsed).toMatchObject({
      sourceState: 'ok', hops: [], returnedHops: 0, skippedRows: 0, truncated: false,
    });
  });

  it('reports permissive file or directory custody as unreadable rather than empty', async () => {
    writeRawLog(row('hop-1') + '\n');
    chmodSync(busHoplogPath(), 0o644);
    if (process.platform === 'win32') return;
    const client = await connect();
    const { parsed } = await callBus(client);
    expect(parsed).toMatchObject({ sourceState: 'unreadable', hops: null, skippedRows: null, truncated: null });
    chmodSync(busHoplogPath(), 0o600);
    chmodSync(dirname(busHoplogPath()), 0o755);
    const dirResult = await callBus(client);
    expect(dirResult.parsed).toMatchObject({ sourceState: 'unreadable', hops: null });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses symlinked and FIFO hop logs without following links or hanging', async () => {
      mkdirSync(dirname(busHoplogPath()), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, 'elsewhere'), row('hop-1') + '\n', { mode: 0o600 });
      symlinkSync(join(root, 'elsewhere'), busHoplogPath());
      expect(readBusHoplogTail(5).state).toBe('unreadable');
      rmSync(busHoplogPath());
      // O_NONBLOCK makes the open return; fstat custody refuses the FIFO.
      execFileSync('mkfifo', [busHoplogPath()]);
      expect(readBusHoplogTail(5).state).toBe('unreadable');
      const { parsed } = await callBus(await connect());
      expect(parsed.sourceState).toBe('unreadable');
      expect(parsed.hops).toBeNull();
    },
  );

  it.each([
    [{ limit: 0 }], [{ limit: 51 }], [{ limit: -1 }], [{ limit: 1.5 }],
    [{ limit: '2' }], [{ limit: null }], [{ limit: 2, extra: 1 }],
    [{ path: '/tmp/hops.jsonl' }], [{ file: 'x' }], [{ command: 'start' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const bus = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), bus });
    await expect(client.callTool({ name: 'fleet_bus_hops', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(bus).not.toHaveBeenCalled();
  });

  it('still rejects arguments on fleet_status and unknown tool names', async () => {
    const bus = vi.fn();
    const client = await connect({ status: vi.fn(), loop: vi.fn(), bus });
    await expect(client.callTool({ name: 'fleet_status', arguments: { limit: 1 } }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: 'fleet_bus' }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: 'fleet_bus_send' }))
      .rejects.toMatchObject({ code: -32602 });
    expect(bus).not.toHaveBeenCalled();
  });

  it('returns the newest validated rows in append order, bounded by limit', async () => {
    for (let i = 1; i <= 5; i++) {
      expect(appendBusHop({ ...ids, id: `hop-${i}`, inputTokens: i })).toBe(true);
    }
    const client = await connect();
    const bounded = await callBus(client, { limit: 2 });
    const hops = bounded.parsed['hops'] as Array<Record<string, unknown>>;
    expect(hops.map(hop => hop['id'])).toEqual(['hop-4', 'hop-5']);
    expect(bounded.parsed).toMatchObject({ returnedHops: 2, truncated: true, limit: 2 });
    for (const hop of hops) {
      expect(Object.keys(hop).sort()).toEqual(['from', 'id', 'inputTokens', 'outputTokens', 'to']);
    }
    expect(hops[1]).toMatchObject({ inputTokens: 5, outputTokens: null });
    const all = await callBus(client);
    expect(all.parsed).toMatchObject({ returnedHops: 5, truncated: false });
  });

  it('skips malformed, invalid and torn rows with explicit skipped evidence', async () => {
    writeRawLog([
      row('hop-1'),
      '{"id":"hop-2"',                    // unterminated JSON mid-log
      'null',                             // parses, but not a hop
      row('hop-3', { inputTokens: -1 }),  // invalid token count fails validation
      '',
      row('hop-4'),
      '{"id":"hop-5","from":"codex-cmp"', // torn tail: no trailing newline
    ].join('\n'));
    const { parsed } = await callBus(await connect(), { limit: 20 });
    expect(parsed['sourceState']).toBe('ok');
    expect((parsed['hops'] as Array<Record<string, unknown>>).map(hop => hop['id']))
      .toEqual(['hop-1', 'hop-4']);
    expect(parsed['skippedRows']).toBe(5);
    expect(parsed['truncated']).toBe(false);
  });

  it('reads only a bounded tail window of an oversized log', async () => {
    const line = row('hop-x', { inputTokens: 1, outputTokens: 2 }) + '\n';
    const count = Math.ceil(BUS_HOPLOG_READ_BYTES / Buffer.byteLength(line)) + 25;
    let bulk = '';
    for (let i = 1; i <= count; i++) bulk += line.replace('hop-x', `hop-${i}`);
    writeRawLog(bulk);
    const tail = readBusHoplogTail(50);
    expect(tail.state).toBe('ok');
    expect(tail.logBytes).toBe(Buffer.byteLength(bulk));
    expect(tail.hops?.length).toBe(50);
    expect(tail.hops?.[49]?.id).toBe(`hop-${count}`);
    expect(tail.truncated).toBe(true);
    expect(tail.skippedRows).toBeGreaterThanOrEqual(1); // the window cut a row
  });

  it('never serializes extra fields, bodies, or credential-shaped labels', async () => {
    // FAKE credential fixture, built only at runtime; assert containment, never print.
    const fake = ['gh', 'p_', 'FAKE', 'y'.repeat(40)].join('');
    writeRawLog([
      row('hop-1', { inputTokens: 3, body: 'PRIVATE-BODY-OCT31', nested: { secret: fake } }),
      JSON.stringify({ id: fake, from: 'a', to: 'b', inputTokens: null, outputTokens: null }),
      row('hop-2'),
    ].join('\n') + '\n');
    const { parsed, text } = await callBus(await connect());
    expect(text).not.toContain('PRIVATE-BODY-OCT31');
    expect(text).not.toContain(fake);
    expect(text).not.toContain('"body"');
    const hops = parsed['hops'] as Array<Record<string, unknown>>;
    // hop-1 revalidates with extras dropped; the credential-id row is skipped.
    expect(hops.map(hop => hop['id'])).toEqual(['hop-1', 'hop-2']);
    expect(parsed['skippedRows']).toBe(1);
    expect(hops[0]).toEqual({
      id: 'hop-1', from: 'codex-cmp', to: 'RQ-EVENTD', inputTokens: 3, outputTokens: null,
    });
  });

  it('keeps the serialized output cap and value scrubbing for bus observations', async () => {
    const fake = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const client = await connect({
      status: async () => ({}),
      loop: async () => ({}),
      bus: async () => ({ note: `token=${fake}` }),
    });
    const { text } = await callBus(client);
    expect(text).not.toContain(fake);
    expect(text).toContain('REDACTED');
    const oversized = await connect({
      status: async () => ({}),
      loop: async () => ({}),
      bus: async () => ({ pad: '界'.repeat(MAX_FLEET_OUTPUT_BYTES / 2) }),
    });
    const result = await oversized.callTool({ name: 'fleet_bus_hops' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });

  it('serves the bus tool without an injected reader while status and loop stay injected', async () => {
    const status = vi.fn(async () => ({ pending: 2 }));
    const loop = vi.fn(async (limit: number) => ({ limit }));
    // Compatible injection: a two-reader object still works; bus falls back to
    // the real hoplog observation against the isolated ASHLR_HOME.
    const client = await connect({ status, loop });
    expect(await client.callTool({ name: 'fleet_status' }))
      .toMatchObject({ content: [{ text: '{"pending":2}' }] });
    expect(await client.callTool({ name: 'fleet_loop', arguments: { limit: 7 } }))
      .toMatchObject({ content: [{ text: '{"limit":7}' }] });
    const { parsed } = await callBus(client);
    expect(parsed['sourceState']).toBe('missing');
    expect(parsed['hops']).toBeNull();
  });
});
