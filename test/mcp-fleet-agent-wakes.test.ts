/**
 * fleet_agent_wakes: the per-agent wake-hint read over the isolated fleet
 * MCP server — the same readAgentWakes projection `phm agents bus wakes`
 * serves, with every filter validated before any store read and every
 * page status passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned wake
 * pages, no bus store, registry, hold table, wake queue or feed access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentWakesArgs, readFleetAgentWakes, type FleetAgentWakesArgs,
} from '../src/mcp/fleet-agent-wakes.js';
import {
  readAgentWakes, readAllWakes, type AgentWakeRow, type AllWakesPage, type WakePage,
} from '../src/core/agents/bus-unified.js';

const connections: Client[] = [];

const wake = (over: Partial<AgentWakeRow> = {}): AgentWakeRow => ({
  kind: 'bus.send', id: 'm-1', from: 'agent:sender', to: 'agent:planner',
  at: 1_800_000_000_000,
  ...over,
});

const okPage = (over: Partial<Extract<WakePage, { status: 'ok' }>> = {}): WakePage => ({
  status: 'ok', agent: 'planner', scope: 'identity',
  wakes: [wake()], matched: 1, truncated: false, ...over,
});

const okAllPage = (over: Partial<Extract<AllWakesPage, { status: 'ok' }>> = {}): AllWakesPage => ({
  status: 'ok', scope: 'fleet',
  wakes: [wake()], matched: 1, truncated: false, ...over,
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
  const client = new Client({ name: 'agent-wakes-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callWakes(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_wakes', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_wakes argument parsing', () => {
  it('leaves agent absent by default and parses every filter without it', () => {
    expect(parseFleetAgentWakesArgs({})).toEqual({});
    expect(parseFleetAgentWakesArgs({ since: '1800000000000', priority: 'P0', contains: 'x' }))
      .toEqual({ since: 1800000000000, priority: 'P0', contains: 'x' });
    expect(parseFleetAgentWakesArgs({ agent: 'planner' })).toEqual({ agent: 'planner' });
    expect(parseFleetAgentWakesArgs({ agent: 'agent:planner' })).toEqual({ agent: 'agent:planner' });
    expect(parseFleetAgentWakesArgs({ agent: 'x'.repeat(128) })).toEqual({ agent: 'x'.repeat(128) });
  });

  it('rejects a malformed agent ref before any read', () => {
    for (const bad of [{ agent: 5 }, { agent: '' }, { agent: 'has space' },
      { agent: 'x'.repeat(129) }, { agent: null }, { agent: true }, { agent: 'line\nbreak' }]) {
      expect(parseFleetAgentWakesArgs(bad)).toBeNull();
    }
  });

  it('maps every shared wakes filter onto the read arguments', () => {
    const parsed = parseFleetAgentWakesArgs({
      agent: 'agent:planner', since: '1800000000000', job: 'RQ-9',
      from: 'agent:sender', excludeFrom: 'agent:bot', priority: 'P0',
      contains: '  Parser   Fix ',
    });
    expect(parsed).toEqual({
      agent: 'agent:planner', since: 1800000000000, job: 'RQ-9',
      from: 'agent:sender', excludeFrom: 'agent:bot', priority: 'P0',
      contains: 'parser fix',
    });
  });

  it('accepts every P0..P3 band and rejects anything outside the enum', () => {
    for (const band of ['P0', 'P1', 'P2', 'P3']) {
      expect(parseFleetAgentWakesArgs({ agent: 'a', priority: band }))
        .toMatchObject({ priority: band });
    }
    for (const bad of ['p0', 'P4', 'high', 'urgent', '', 5, null, true, ['P0']]) {
      expect(parseFleetAgentWakesArgs({ agent: 'a', priority: bad })).toBeNull();
    }
  });

  it('resolves the shared since grammar to epoch ms', () => {
    const parsed = parseFleetAgentWakesArgs({ agent: 'a', since: '2026-01-01T00:00:00.000Z' });
    expect(parsed).toMatchObject({ since: Date.parse('2026-01-01T00:00:00.000Z') });
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { agent: 'a', extra: 1 }, { agent: 'a', root: '/tmp/fake' }, { agent: 'a', path: '/tmp/x' },
      { agent: 'a', cwd: '/tmp' }, { agent: 'a', runsDir: '/tmp' }, { agent: 'a', home: '/tmp' },
      { agent: 'a', limit: 5 }, { agent: 'a', after: 0 }, { agent: 'a', matched: true },
      { agent: 'a', job: 'has space' }, { agent: 'a', job: '' }, { agent: 'a', job: 5 },
      { agent: 'a', from: 5 }, { agent: 'a', excludeFrom: null }, { agent: 'a', excludeFrom: 'has space' },
      { agent: 'a', priority: 'P4' }, { agent: 'a', priority: 'high' }, { agent: 'a', priority: 5 },
      { agent: 'a', since: 'never' }, { agent: 'a', since: 5 }, { agent: 'a', since: '' },
      { agent: 'a', since: '1960-01-01T00:00:00.000Z' },
      { agent: 'a', contains: '' }, { agent: 'a', contains: '   ' },
      { agent: 'a', contains: 'x'.repeat(513) }, { agent: 'a', contains: 42 },
    ]) expect(parseFleetAgentWakesArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_wakes reader', () => {
  it('runs the shared read with the parsed ref, cutoff and filters', async () => {
    const seen: Array<[string, number | undefined, unknown, unknown]> = [];
    const read: typeof readAgentWakes = (ref, sinceAt, _options, filter) => {
      seen.push([ref, sinceAt, _options, filter]);
      return okPage({ matched: 3 });
    };
    const result = await readFleetAgentWakes(
      parseFleetAgentWakesArgs({ agent: 'planner', since: '1800000000000', job: 'RQ-9', from: 'agent:sender', priority: 'P1' })!,
      { read });
    expect(seen).toEqual([['planner', 1800000000000, {}, { job: 'RQ-9', from: 'agent:sender', priority: 'P1' }]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', agent: 'planner', scope: 'identity', matched: 3, truncated: false,
    });
    expect(result.wakes).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes an unfiltered read through with undefined cutoff and empty filter', async () => {
    const seen: Array<[string, number | undefined, unknown, unknown]> = [];
    const read: typeof readAgentWakes = (ref, sinceAt, _options, filter) => {
      seen.push([ref, sinceAt, _options, filter]);
      return okPage({ wakes: [] });
    };
    const result = await readFleetAgentWakes(parseFleetAgentWakesArgs({ agent: 'planner' })!, { read });
    expect(seen).toEqual([['planner', undefined, {}, {}]]);
    expect(result).toMatchObject({ status: 'ok', wakes: [], matched: 1 });
  });

  it('keeps the label-scope fallback the CLI read reports', async () => {
    const read: typeof readAgentWakes = () =>
      okPage({ agent: 'bare-label', scope: 'label' });
    const result = await readFleetAgentWakes(parseFleetAgentWakesArgs({ agent: 'bare-label' })!, { read });
    expect(result).toMatchObject({ status: 'ok', agent: 'bare-label', scope: 'label' });
  });

  it('runs the fleet-wide readAllWakes projection when agent is omitted', async () => {
    const seen: Array<[number | undefined, unknown, unknown]> = [];
    const readAll: typeof readAllWakes = (sinceAt, _options, filter) => {
      seen.push([sinceAt, _options, filter]);
      return okAllPage({ matched: 4 });
    };
    const read = vi.fn();
    const result = await readFleetAgentWakes(
      parseFleetAgentWakesArgs({ since: '1800000000000', job: 'RQ-9', priority: 'P1' })!,
      { read, readAll });
    expect(read).not.toHaveBeenCalled();
    expect(seen).toEqual([[1800000000000, {}, { job: 'RQ-9', priority: 'P1' }]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', scope: 'fleet', matched: 4, truncated: false,
    });
    expect(result.wakes).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes an unfiltered fleet read through with undefined cutoff and empty filter', async () => {
    const seen: Array<[number | undefined, unknown, unknown]> = [];
    const readAll: typeof readAllWakes = (sinceAt, _options, filter) => {
      seen.push([sinceAt, _options, filter]);
      return okAllPage({ wakes: [] });
    };
    const result = await readFleetAgentWakes(parseFleetAgentWakesArgs({})!, { readAll });
    expect(seen).toEqual([[undefined, {}, {}]]);
    expect(result).toMatchObject({ status: 'ok', scope: 'fleet', wakes: [], matched: 1 });
  });

  it.each([
    { status: 'unknown-agent', reason: 'Agent is not a registered identity.' },
    { status: 'unavailable', reason: 'Wake queue is unreadable.' },
    { status: 'invalid', reason: 'Invalid job id.' },
  ] as const)('passes a refused page through untouched: %j', async page => {
    const read: typeof readAgentWakes = () => page;
    const result = await readFleetAgentWakes(parseFleetAgentWakesArgs({ agent: 'ghost' })!, { read });
    expect(result).toMatchObject({ status: page.status, reason: page.reason });
    expect(result.wakes).toBeUndefined();
    expect(result.matched).toBeUndefined();
  });
});

describe('fleet_agent_wakes MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_wakes');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.description).toContain('fleet-wide');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: [] });
    expect(tool?.inputSchema.properties?.['agent'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] });
    expect(tool?.inputSchema.properties?.['contains'])
      .toMatchObject({ type: 'string', minLength: 1, maxLength: 512 });
  });

  it.each([
    [{ agent: '' }], [{ agent: 'has space' }], [{ agent: 5 }],
    [{ agent: 'a', root: '/tmp/fake-root' }], [{ agent: 'a', path: '/tmp/x' }], [{ agent: 'a', cwd: '/tmp' }],
    [{ agent: 'a', limit: 5 }], [{ agent: 'a', after: 0 }], [{ agent: 'a', matched: true }],
    [{ agent: 'a', job: 'has space' }], [{ agent: 'a', from: 5 }], [{ agent: 'a', excludeFrom: null }],
    [{ agent: 'a', priority: 'P4' }], [{ agent: 'a', priority: 'high' }], [{ agent: 'a', priority: 5 }],
    [{ agent: 'a', since: 'never' }], [{ agent: 'a', since: 5 }],
    [{ agent: 'a', contains: '' }], [{ agent: 'a', contains: 'x'.repeat(513) }], [{ agent: 'a', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentWakes = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentWakes });
    await expect(client.callTool({ name: 'fleet_agent_wakes', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentWakes).not.toHaveBeenCalled();
  });

  it('passes the validated arguments to the injected reader and returns its page', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ok', agent: 'planner', scope: 'identity',
      wakes: [wake()], matched: 3, truncated: true,
    };
    const agentWakes = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentWakes });
    const { parsed } = await callWakes(client, {
      agent: 'planner', since: '1800000000000', job: 'RQ-9', priority: 'P2', contains: 'Parser Fix',
    });
    expect(agentWakes).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'planner', since: 1800000000000, job: 'RQ-9', priority: 'P2', contains: 'parser fix',
    }));
    const args = agentWakes.mock.calls[0]![0] as FleetAgentWakesArgs;
    expect(args.from).toBeUndefined();
    expect(args.excludeFrom).toBeUndefined();
    expect(parsed).toEqual(payload);
  });

  it('serves the fleet-wide page when agent is omitted', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ok', scope: 'fleet',
      wakes: [wake({ to: 'fleet.mesh' })], matched: 2, truncated: false,
    };
    const agentWakes = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentWakes });
    const { parsed } = await callWakes(client, { priority: 'P0' });
    // The shared reader sees the parsed args with no agent — the fleet-wide
    // branch inside readFleetAgentWakes picks readAllWakes.
    expect(agentWakes).toHaveBeenCalledWith(expect.objectContaining({ priority: 'P0' }));
    const args = agentWakes.mock.calls[0]![0] as FleetAgentWakesArgs;
    expect(args.agent).toBeUndefined();
    expect(parsed).toEqual(payload);
  });
});
