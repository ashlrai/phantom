/**
 * fleet_work_feed: the bus v2 work-feed projection over the isolated fleet
 * MCP server — the same readBusWorkFeed + projectBusWorkFeedView read
 * `phm fleet work-feed`, `phm agents bus work feed` and GET
 * /api/verse/agent-bus/work-feed serve, with every filter validated by the
 * shared parseBusWorkFeedQuery contract.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned feed
 * results, no bus store, registry or coordination-table access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  FLEET_WORK_FEED_LIMIT_DEFAULT, FLEET_WORK_FEED_LIMIT_MAX,
  parseFleetWorkFeedArgs, readFleetWorkFeed,
} from '../src/mcp/fleet-work-feed.js';
import type { BusWorkFeedJob, BusWorkFeedReadOptions, BusWorkFeedReadResult } from '../src/core/agents/bus-work-feed-read.js';

const connections: Client[] = [];

const job = (id: string, over: Partial<BusWorkFeedJob> = {}): BusWorkFeedJob => ({
  id, owner: 'agent:planner', to: 'leaders', provider: 'devin', repo: 'ashlrai/phantom',
  title: `Work ${id}`, claimKeys: ['repo:ashlrai/phantom'], status: 'queued',
  updatedAt: 1_800_000_000_000, postId: `post-${id}`, statusId: null, ...over,
});

const feed = (
  jobs: BusWorkFeedJob[],
  over: Partial<Extract<BusWorkFeedReadResult, { status: 'ok' }>> = {},
): BusWorkFeedReadResult => ({
  status: 'ok', jobs, receipts: 3, asOf: '2026-01-01T00:00:00.000Z', ...over,
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
  const client = new Client({ name: 'work-feed-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callFeed(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_work_feed', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_work_feed argument parsing', () => {
  it('defaults to a bounded unfiltered read', () => {
    expect(parseFleetWorkFeedArgs({})).toEqual({ limit: FLEET_WORK_FEED_LIMIT_DEFAULT, claims: false, filters: {} });
    expect(FLEET_WORK_FEED_LIMIT_DEFAULT).toBe(50);
    expect(FLEET_WORK_FEED_LIMIT_MAX).toBe(200);
  });

  it('accepts the limit bounds and rejects everything else', () => {
    for (const limit of [1, 200]) expect(parseFleetWorkFeedArgs({ limit })?.limit).toBe(limit);
    for (const limit of [0, 201, 1.5, '5', null, true]) expect(parseFleetWorkFeedArgs({ limit })).toBeNull();
  });

  it('maps the hold flags to the shared claims join', () => {
    expect(parseFleetWorkFeedArgs({ claims: true })).toMatchObject({ claims: true, filters: {} });
    expect(parseFleetWorkFeedArgs({ open: true })).toMatchObject({ claims: true, filters: { open: true } });
    expect(parseFleetWorkFeedArgs({ claimable: true })).toMatchObject({ claims: true, filters: { claimable: true } });
    expect(parseFleetWorkFeedArgs({ claims: false, open: false, claimable: false }))
      .toMatchObject({ claims: false, filters: {} });
    for (const bad of [{ claims: 'yes' }, { open: 1 }, { claimable: null }]) {
      expect(parseFleetWorkFeedArgs(bad)).toBeNull();
    }
  });

  it('passes the shared filter dimensions through the shared validator', () => {
    expect(parseFleetWorkFeedArgs({ status: 'running' })?.filters).toMatchObject({ status: 'running' });
    expect(parseFleetWorkFeedArgs({ job: 'RQ-1' })?.filters).toMatchObject({ jobId: 'RQ-1' });
    expect(parseFleetWorkFeedArgs({ repo: 'Owner/Name' })?.filters).toMatchObject({ repo: 'owner/name' });
    expect(parseFleetWorkFeedArgs({ provider: 'claude' })?.filters).toMatchObject({ provider: 'claude' });
    expect(parseFleetWorkFeedArgs({ tier: 'frontier' })?.filters).toMatchObject({ tier: 'frontier' });
    expect(parseFleetWorkFeedArgs({ to: 'leaders' })?.filters.toMatch).toBeTypeOf('function');
    expect(parseFleetWorkFeedArgs({ owner: 'agent:planner' })?.filters.ownerMatch).toBeTypeOf('function');
    expect(parseFleetWorkFeedArgs({ since: '1800000000000' })?.filters).toMatchObject({ since: 1800000000000 });
    expect(parseFleetWorkFeedArgs({ before: '1800000000000' })?.filters).toMatchObject({ before: 1800000000000 });
    expect(parseFleetWorkFeedArgs({ contains: 'parser' })?.filters).toMatchObject({ contains: 'parser' });
    expect(parseFleetWorkFeedArgs({ channel: 'release' })?.filters).toMatchObject({ channel: 'release' });
    expect(parseFleetWorkFeedArgs({ topic: 'deploy' })?.filters).toMatchObject({ topic: 'deploy' });
    expect(parseFleetWorkFeedArgs({ result: 'complete' })?.filters).toMatchObject({ result: 'complete' });
    expect(parseFleetWorkFeedArgs({ id: 'm-9' })?.filters).toMatchObject({ id: 'm-9' });
  });

  it('rejects unknown keys, caller roots and malformed values before any read', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp' },
      { status: 'bogus' }, { status: 5 }, { job: 'has space' }, { job: '' },
      { repo: 'no-slash' }, { repo: 'a/b/c' }, { provider: 'bogus' }, { tier: 'bogus' },
      { to: 'has space' }, { owner: 5 }, { since: 'not-a-time' }, { since: '' },
      { before: 'not-a-time' }, { before: '' }, { before: 5 },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 42 },
      { channel: 'Has Space' }, { channel: '' }, { channel: 5 }, { channel: 'x'.repeat(33) },
      { topic: 'Has Space' }, { topic: '' }, { topic: 5 }, { topic: 'x'.repeat(33) }, { topic: 'UPPER' },
      { result: 'bogus' }, { result: 'COMPLETE' }, { result: '' }, { result: 5 }, { result: null },
      { id: 'has space' }, { id: '' }, { id: 5 }, { id: null },
      { status: null }, { job: null },
    ]) expect(parseFleetWorkFeedArgs(bad)).toBeNull();
  });
});

describe('fleet_work_feed reader', () => {
  it('applies the shared view filters and slices newest-first with honest counts', async () => {
    const jobs = [
      job('old', { updatedAt: 100, status: 'done' }),
      job('new', { updatedAt: 300, status: 'queued' }),
      job('mid', { updatedAt: 200, status: 'running' }),
    ];
    const seen: BusWorkFeedReadOptions[] = [];
    const read = (options: BusWorkFeedReadOptions) => {
      seen.push(options);
      return feed(jobs);
    };
    const result = await readFleetWorkFeed(parseFleetWorkFeedArgs({ limit: 2 })!, { read });
    expect(seen).toEqual([{ claims: false }]);
    expect(result).toMatchObject({ status: 'ok', matched: 3, omitted: 1 });
    const shown = (result as Extract<BusWorkFeedReadResult, { status: 'ok' }>).jobs;
    expect(shown.map(item => item.id)).toEqual(['new', 'mid']);
  });

  it('narrows through the same filters the CLI flags apply', async () => {
    const jobs = [job('a', { status: 'done', updatedAt: 100 }), job('b', { status: 'queued', updatedAt: 200 })];
    const result = await readFleetWorkFeed(parseFleetWorkFeedArgs({ status: 'done' })!, { read: () => feed(jobs) });
    expect(result).toMatchObject({ status: 'ok', matched: 1, omitted: 0 });
    expect((result as Extract<BusWorkFeedReadResult, { status: 'ok' }>).jobs.map(item => item.id)).toEqual(['a']);
  });

  it('joins claims only when a hold flag asked for it and regroups holds under shown jobs', async () => {
    const jobs = [job('a', { updatedAt: 300 }), job('b', { updatedAt: 200 }), job('c', { updatedAt: 100 })];
    const claims = {
      source: 'available' as const, truncated: false,
      holds: [
        { jobId: 'a', claimKey: 'repo:ashlrai/phantom', owner: 'agent:x', leaseUntil: 1, origin: 'resource' as const, sourceId: 's1' },
        { jobId: 'c', claimKey: 'repo:ashlrai/phantom', owner: 'agent:y', leaseUntil: 1, origin: 'resource' as const, sourceId: 's2' },
      ],
    };
    const read = vi.fn(() => feed(jobs, { claims }));
    const result = await readFleetWorkFeed(parseFleetWorkFeedArgs({ limit: 2, claims: true })!, { read });
    expect(read).toHaveBeenCalledWith({ claims: true });
    const shown = result as Extract<BusWorkFeedReadResult, { status: 'ok' }> & { matched: number; omitted: number };
    expect(shown.jobs.map(item => item.id)).toEqual(['a', 'b']);
    expect(shown.claims?.holds.map(hold => hold.jobId)).toEqual(['a']);
    expect(shown.matched).toBe(3);
  });

  it('passes refused and unavailable feeds through untouched', async () => {
    const refused: BusWorkFeedReadResult = { status: 'refused', reason: 'duplicate-job', receipts: 2, asOf: '2026-01-01T00:00:00.000Z' };
    expect(await readFleetWorkFeed(parseFleetWorkFeedArgs({})!, { read: () => refused })).toBe(refused);
    const unavailable: BusWorkFeedReadResult = { status: 'unavailable', asOf: '2026-01-01T00:00:00.000Z' };
    expect(await readFleetWorkFeed(parseFleetWorkFeedArgs({})!, { read: () => unavailable })).toBe(unavailable);
  });
});

describe('fleet_work_feed MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_work_feed');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 200, default: 50 });
    expect(tool?.inputSchema.properties?.['claims']).toMatchObject({ type: 'boolean' });
    expect(tool?.inputSchema.properties?.['status'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['queued', 'running', 'done']) });
    expect(tool?.inputSchema.properties?.['provider'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['devin', 'claude']) });
    expect(tool?.inputSchema.properties?.['tier'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['fast', 'frontier']) });
    expect(tool?.inputSchema.properties?.['before']).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['topic'])
      .toMatchObject({ type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' });
    expect(tool?.inputSchema.properties?.['id'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ limit: 0 }], [{ limit: 201 }],
    [{ limit: '5' }], [{ status: 'bogus' }], [{ claims: 'true' }], [{ extra: 1 }],
    [{ job: 'has space' }], [{ contains: '' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const workFeed = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), workFeed });
    await expect(client.callTool({ name: 'fleet_work_feed', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(workFeed).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = { status: 'ok', jobs: [job('a'), job('b')], matched: 2, omitted: 0, receipts: 3, asOf: '2026-01-01T00:00:00.000Z' };
    const workFeed = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), workFeed });
    const { parsed } = await callFeed(client, { status: 'queued', limit: 10, claims: true });
    expect(workFeed).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, claims: true }));
    const filters = (workFeed.mock.calls[0]![0] as { filters: Record<string, unknown> }).filters;
    expect(filters).toMatchObject({ status: 'queued' });
    expect(parsed).toEqual(payload);
  });
});
