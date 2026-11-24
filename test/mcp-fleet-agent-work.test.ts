/**
 * fleet_agent_work: the per-agent pending-work digest over the isolated
 * fleet MCP server — the same readBusWorkMineWithSeats projection
 * `phm agents bus work mine` serves, with agent/job/since/before/contains
 * validated before any store read and non-ok digests passed through
 * untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, a canned digest,
 * no bus store, registry, hold table, feed, mailbox, board, wake-queue or
 * seat-file access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentWorkArgs, readFleetAgentWork,
} from '../src/mcp/fleet-agent-work.js';
import type { BusWorkMineOptions, BusWorkMineResult } from '../src/core/agents/bus-work-mine.js';

const connections: Client[] = [];

const digest = (
  over: Partial<Extract<BusWorkMineResult, { status: 'ok' }>> = {},
): BusWorkMineResult => ({
  status: 'ok',
  agent: { ref: 'planner', handle: 'planner', identity: 'agt_planner', registry: 'available' },
  asOf: '2026-01-01T00:00:00.000Z',
  claims: { status: 'ok', source: 'missing', claims: [],
    owner: { ref: 'planner', identity: 'agt_planner', registry: 'available' } },
  jobs: { status: 'ok', holds: 'complete', open: 0, receipts: 0, truncated: false, jobs: [] },
  announced: { status: 'ok', matched: 0, items: [], truncated: false },
  next: { status: 'ok', holds: 'complete', matched: 0, items: [], truncated: false },
  handoffs: { status: 'ok', holds: 'complete', matched: 0, items: [], truncated: false },
  threads: { status: 'ok', source: 'missing', matched: 0, items: [], truncated: false, skipped: 0 },
  awaiting: { status: 'ok', source: 'missing', matched: 0, items: [], truncated: false, skipped: 0 },
  blocked: { status: 'ok', source: 'missing', matched: 0, items: [], truncated: false, skipped: 0 },
  wakes: { status: 'ok', agent: 'planner', scope: 'identity', wakes: [], matched: 0, truncated: false },
  inbox: { status: 'ok', agent: 'planner', messages: [], nextCursor: 0, matched: 0, truncated: false },
  mailbox: { status: 'ok', agent: 'planner', messages: [], matched: 0, truncated: false },
  board: { status: 'ok', peers: [], claims: 'readable', threads: [],
    deliveries: { matched: 0, items: [], truncated: false },
    tasks: { matched: 0, items: [], truncated: false } },
  channels: { status: 'ok', source: 'missing', channels: [] },
  seats: { status: 'ok', matched: 0, seats: [], truncated: false },
  ...over,
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});

async function connect(readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'agent-work-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callWork(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_work', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_work argument parsing', () => {
  it('requires agent and leaves every filter absent by default', () => {
    expect(parseFleetAgentWorkArgs({ agent: 'planner' })).toEqual({ agent: 'planner' });
    expect(parseFleetAgentWorkArgs({ agent: 'agent:planner' })).toEqual({ agent: 'agent:planner' });
  });

  it('rejects a missing or malformed agent ref before any read', () => {
    for (const bad of [{}, { agent: 5 }, { agent: '' }, { agent: 'has space' },
      { agent: 'x'.repeat(129) }, { agent: null }, { agent: true }]) {
      expect(parseFleetAgentWorkArgs(bad)).toBeNull();
    }
  });

  it('maps the shared job, since, before and contains filters onto the read options', () => {
    const parsed = parseFleetAgentWorkArgs({
      agent: 'planner', job: 'RQ-9', since: '1800000000000', before: '1900000000000',
      contains: '  Parser   Fix ',
    });
    expect(parsed).toEqual({ agent: 'planner', job: 'RQ-9', since: 1800000000000,
      before: 1900000000000, contains: 'parser fix' });
  });

  it('maps the shared priority band onto the read options', () => {
    for (const priority of ['P0', 'P1', 'P2', 'P3']) {
      expect(parseFleetAgentWorkArgs({ agent: 'a', priority })).toEqual({ agent: 'a', priority });
    }
    for (const priority of ['P9', 'p0', 'urgent', '', 5, null, true]) {
      expect(parseFleetAgentWorkArgs({ agent: 'a', priority })).toBeNull();
    }
  });

  it('maps the shared channel room onto the read options', () => {
    for (const channel of ['eng', 'eng-1', 'e_2', 'e'.repeat(32)]) {
      expect(parseFleetAgentWorkArgs({ agent: 'a', channel })).toEqual({ agent: 'a', channel });
    }
    for (const channel of ['Eng', 'has space', 'a'.repeat(33), '-lead', '', 5, null, true]) {
      expect(parseFleetAgentWorkArgs({ agent: 'a', channel })).toBeNull();
    }
  });

  it('accepts the shared since and before grammar and rejects the rest', () => {
    for (const bound of ['15m', '2h', '1d', '1800000000000', '2026-01-01T00:00:00.000Z']) {
      const parsedSince = parseFleetAgentWorkArgs({ agent: 'a', since: bound });
      expect(parsedSince).not.toBeNull();
      expect(typeof parsedSince!.since).toBe('number');
      expect(parsedSince!.since!).toBeGreaterThanOrEqual(0);
      const parsedBefore = parseFleetAgentWorkArgs({ agent: 'a', before: bound });
      expect(parsedBefore).not.toBeNull();
      expect(typeof parsedBefore!.before).toBe('number');
      expect(parsedBefore!.before!).toBeGreaterThanOrEqual(0);
    }
    for (const bound of ['never', '', 5, null, true, '99999999999999999']) {
      expect(parseFleetAgentWorkArgs({ agent: 'a', since: bound })).toBeNull();
      expect(parseFleetAgentWorkArgs({ agent: 'a', before: bound })).toBeNull();
    }
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { agent: 'a', extra: 1 }, { agent: 'a', root: '/tmp/fake' }, { agent: 'a', path: '/tmp/x' },
      { agent: 'a', cwd: '/tmp' }, { agent: 'a', runsDir: '/tmp' }, { agent: 'a', home: '/tmp' },
      { agent: 'a', mailbox: '/tmp' }, { agent: 'a', board: '/tmp' }, { agent: 'a', seats: '/tmp' },
      { agent: 'a', job: 'has space' }, { agent: 'a', job: '' }, { agent: 'a', job: 5 },
      { agent: 'a', contains: '' }, { agent: 'a', contains: '   ' },
      { agent: 'a', contains: 'x'.repeat(513) }, { agent: 'a', contains: 42 },
      { agent: 'a', since: 'never' }, { agent: 'a', since: 5 },
      { agent: 'a', before: 'never' }, { agent: 'a', before: 5 },
      { agent: 'a', priority: 'P9' }, { agent: 'a', priority: 'urgent' }, { agent: 'a', priority: 5 },
      { agent: 'a', channel: 'Eng' }, { agent: 'a', channel: 'has space' },
      { agent: 'a', channel: 'a'.repeat(33) }, { agent: 'a', channel: '' }, { agent: 'a', channel: 5 },
      { agent: 'a', limit: 10 }, { agent: 'a', after: 0 }, { agent: 'a', matched: true },
    ]) expect(parseFleetAgentWorkArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_work reader', () => {
  it('runs the shared digest read with the parsed filters and returns it untouched', async () => {
    const seen: Array<[string, BusWorkMineOptions]> = [];
    const canned = digest({ job: 'RQ-9', contains: 'parser fix', since: '2027-01-14T22:13:20.000Z',
      before: '2027-01-15T22:13:20.000Z', priority: 'P1', channel: 'eng' });
    const mine = async (agent: string, options: BusWorkMineOptions): Promise<BusWorkMineResult> => {
      seen.push([agent, options]);
      return canned;
    };
    const result = await readFleetAgentWork(
      parseFleetAgentWorkArgs({ agent: 'planner', job: 'RQ-9', since: '1800000000000',
        before: '1900000000000', contains: 'Parser Fix', priority: 'P1', channel: 'eng' })!,
      { mine });
    expect(seen).toEqual([['planner', { job: 'RQ-9', since: 1800000000000, before: 1900000000000,
      contains: 'parser fix', priority: 'P1', channel: 'eng' }]]);
    expect(result).toBe(canned);
  });

  it('passes an unfiltered read with no option keys at all', async () => {
    let seenOptions: BusWorkMineOptions | undefined;
    const mine = async (_agent: string, options: BusWorkMineOptions): Promise<BusWorkMineResult> => {
      seenOptions = options;
      return digest();
    };
    await readFleetAgentWork(parseFleetAgentWorkArgs({ agent: 'planner' })!, { mine });
    expect(seenOptions).toEqual({});
  });

  it.each([
    { status: 'invalid', reason: 'invalid-agent' },
    { status: 'invalid', reason: 'invalid-since' },
  ] as const)('passes a refused digest through untouched: %j', async refused => {
    const mine = async (): Promise<BusWorkMineResult> => refused;
    const result = await readFleetAgentWork(parseFleetAgentWorkArgs({ agent: 'ghost' })!, { mine });
    expect(result).toEqual(refused);
  });

  it('keeps per-section unavailable states exactly as the projection reports them', async () => {
    const degraded = digest({
      claims: { status: 'unavailable' },
      inbox: { status: 'unavailable', reason: 'Bus store is not readable.' },
      seats: { status: 'unavailable', reason: 'Seat file is not readable.' },
    });
    const mine = async (): Promise<BusWorkMineResult> => degraded;
    const result = await readFleetAgentWork(parseFleetAgentWorkArgs({ agent: 'planner' })!, { mine });
    expect(result).toBe(degraded);
    expect(result).toMatchObject({
      claims: { status: 'unavailable' },
      inbox: { status: 'unavailable' },
      seats: { status: 'unavailable' },
    });
  });
});

describe('fleet_agent_work MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_work');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['agent'] });
    expect(tool?.inputSchema.properties?.['job'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.inputSchema.properties?.['since']).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['before']).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['contains'])
      .toMatchObject({ type: 'string', minLength: 1, maxLength: 512 });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] });
    expect(tool?.inputSchema.properties?.['channel'])
      .toMatchObject({ type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' });
  });

  it.each([
    [{}], [{ agent: '' }], [{ agent: 'has space' }], [{ agent: 5 }],
    [{ agent: 'a', root: '/tmp/fake-root' }], [{ agent: 'a', path: '/tmp/x' }], [{ agent: 'a', cwd: '/tmp' }],
    [{ agent: 'a', runsDir: '/tmp' }], [{ agent: 'a', mailbox: '/tmp' }], [{ agent: 'a', seats: '/tmp' }],
    [{ agent: 'a', job: 'has space' }], [{ agent: 'a', since: 'never' }], [{ agent: 'a', since: 5 }],
    [{ agent: 'a', before: 'never' }], [{ agent: 'a', before: 5 }],
    [{ agent: 'a', contains: '' }], [{ agent: 'a', contains: 'x'.repeat(513) }],
    [{ agent: 'a', priority: 'P9' }], [{ agent: 'a', priority: 'urgent' }],
    [{ agent: 'a', channel: 'Eng' }], [{ agent: 'a', channel: 'has space' }], [{ agent: 'a', channel: 5 }],
    [{ agent: 'a', limit: 10 }], [{ agent: 'a', after: 0 }], [{ agent: 'a', matched: true }],
    [{ agent: 'a', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentWork = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentWork });
    await expect(client.callTool({ name: 'fleet_agent_work', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentWork).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = digest({ job: 'RQ-9', contains: 'parser fix' });
    const agentWork = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentWork });
    const { parsed } = await callWork(client, { agent: 'planner', job: 'RQ-9', contains: 'Parser Fix', since: '1800000000000', before: '1900000000000', priority: 'P2', channel: 'eng' });
    expect(agentWork).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'planner', job: 'RQ-9', contains: 'parser fix', since: 1800000000000, before: 1900000000000,
      priority: 'P2', channel: 'eng',
    }));
    expect(parsed).toEqual(payload);
  });
});
