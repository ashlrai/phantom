/**
 * fleet_channels_overview: the owner-channel matrix over the isolated
 * fleet MCP server — the same readChannelsOverview projection `phm
 * channels` and GET /api/channels serve. fleet_channel_health answers
 * only the Slack/iMessage bridge slice; this is the whole eight-channel
 * matrix in one call, with no arguments accepted and the projection's
 * masked addresses and unknown-stays-unknown honesty passed through
 * untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, and a crafted
 * ChannelFacts fixture for the real-projection test — never the real
 * home, config, inbox or bridge stores.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetChannelsOverviewArgs, readFleetChannelsOverview } from '../src/mcp/fleet-channels-overview.js';
import { readChannelsOverview, type ChannelFacts } from '../src/core/fleet/channels-overview.js';
import type { ChannelsOverview } from '../src/core/fleet/channels-schema.js';
import type { ChannelStatusRow } from '../src/core/fleet/channels.js';

const connections: Client[] = [];
const TOOL = 'fleet_channels_overview';

const overview = (over: Partial<ChannelsOverview> = {}): ChannelsOverview => ({
  schema: 'phantom.channels.v1', version: 1, at: '2026-11-18T12:00:00.000Z',
  counts: { connected: 1, 'not-set-up': 1, failing: 1, unknown: 5 },
  channels: [{
    channel: 'email', label: 'Email', state: 'connected', reason: null,
    lastInboundAt: '2026-11-18T11:00:00.000Z', lastOutboundAt: 'unknown',
    messages24h: 3, verifiedSenders: 2, address: '***@example.com', next: null,
  }],
  ...over,
});

const statusRow = (kind: ChannelStatusRow['kind'], over: Partial<ChannelStatusRow> = {}): ChannelStatusRow => ({
  kind, configured: true, credential: 'config', paired: null,
  received: 0, lastSeenAt: null, pendingOutbound: 0, ready: true, ...over,
});

/** A crafted facts fixture: email connected with senders, telegram not set
 * up, mobile failing, the rest connected; Slack/iMessage health unreadable
 * so their rows stay honestly unknown. */
const facts = (): ChannelFacts => ({
  now: new Date('2026-11-18T12:00:00Z'),
  status: {
    v: 1, at: '2026-11-18T12:00:00.000Z', inbox: 'healthy',
    channels: [
      statusRow('email', { paired: true, received: 4, lastSeenAt: '2026-11-18 11:00', pendingOutbound: 1 }),
      statusRow('telegram', { configured: false, credential: 'missing', ready: false, next: 'run `phm channels add telegram <chat-id>`' }),
      statusRow('mobile', { configured: true, credential: 'missing', ready: false, paired: false, next: 'pair a phone' }),
      statusRow('desktop'), statusRow('page'), statusRow('cli'),
    ],
  },
  inbox: [
    { at: '2026-11-18T10:30:00.000Z', source: 'email' },
    { at: '2026-11-18T11:00:00.000Z', source: 'telegram' },
    { at: '2026-11-17T09:00:00.000Z', source: 'email' },
  ],
  health: null,
  relay: {
    slack: { inbound: 'unknown', replies: 'unknown' },
    imessage: { inbound: 'unknown', replies: 'unknown' },
  },
  verified: { email: 2, mobile: 'unknown', slack: 'unknown', imessage: 1 },
  emailConfig: 'ok',
  addresses: { telegram: ['123456789'], email: ['mason@example.com'] },
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'channels-overview-test', version: '1.0.0' });
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

describe('fleet_channels_overview argument parsing', () => {
  it('accepts only an empty argument object — every store root stays server-owned', () => {
    expect(parseFleetChannelsOverviewArgs({})).toEqual({});
  });

  it('rejects every key before any read runs', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { channel: 'email' }, { limit: 1 }, { extra: 1 }, { json: true },
    ]) expect(parseFleetChannelsOverviewArgs(bad)).toBeNull();
  });
});

describe('fleet_channels_overview reader', () => {
  it('spreads the shared projection beside the envelope metadata', async () => {
    const seen: unknown[][] = [];
    const read = async () => {
      seen.push([]);
      return overview();
    };
    const result = await readFleetChannelsOverview({ overview: read });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'phantom.channels.v1', version: 1,
      counts: { connected: 1, 'not-set-up': 1, failing: 1, unknown: 5 },
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const channels = (result as ChannelsOverview).channels;
    expect(channels[0]).toMatchObject({ channel: 'email', state: 'connected', address: '***@example.com' });
  });

  it('reports an unreadable overview as unavailable — never an invented healthy matrix', async () => {
    const result = await readFleetChannelsOverview({
      overview: async () => { throw new Error('config store unreadable'); },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'channels-overview-unreadable',
    });
    expect('channels' in result).toBe(false);
    expect('counts' in result).toBe(false);
  });

  it('serves the real readChannelsOverview projection from crafted facts, read-only', async () => {
    const result = await readFleetChannelsOverview({
      overview: () => readChannelsOverview(async () => facts()),
    });
    const report = result as ChannelsOverview;
    expect(report.schema).toBe('phantom.channels.v1');
    const byChannel = new Map(report.channels.map(row => [row.channel, row]));
    expect(byChannel.get('email')).toMatchObject({ state: 'connected', verifiedSenders: 2, messages24h: 1 });
    expect(byChannel.get('telegram')).toMatchObject({ state: 'not-set-up' });
    expect(byChannel.get('mobile')).toMatchObject({ state: 'failing' });
    // Slack and iMessage health could not be read: unknown, never a guessed state.
    expect(byChannel.get('slack')?.state).toBe('unknown');
    expect(byChannel.get('imessage')?.state).toBe('unknown');
    // Raw addresses never leave: telegram chat id and email sender are masked.
    const telegram = byChannel.get('telegram')!.address!;
    const email = byChannel.get('email')!.address!;
    expect(telegram).not.toContain('123456789');
    expect(email).not.toContain('mason');
    expect(email).toMatch(/^\*+\.com$/);
    // Counts are measured over the fixture: two states populated.
    expect(report.counts).toMatchObject({ connected: expect.any(Number), unknown: expect.any(Number) });
  });
});

describe('fleet_channels_overview MCP tool', () => {
  it('is advertised read-only with an empty argument schema beside fleet_channel_health', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === TOOL);
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('readChannelsOverview');
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ home: '/tmp' }], [{ channel: 'email' }], [{ limit: 5 }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const channelsOverview = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), channelsOverview });
    await expect(client.callTool({ name: TOOL, arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(channelsOverview).not.toHaveBeenCalled();
  });

  it('calls the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', ...overview(),
    };
    const channelsOverview = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), channelsOverview });
    const { parsed } = await call(client, {});
    expect(channelsOverview).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
    const channels = parsed.channels as ChannelsOverview['channels'];
    expect(channels[0]).toMatchObject({ channel: 'email', state: 'connected' });
  });

  it('accepts an omitted arguments object', async () => {
    const channelsOverview = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), channelsOverview });
    const { parsed } = await call(client);
    expect(channelsOverview).toHaveBeenCalledWith();
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      channelsOverview: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: TOOL, arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_channels_overview` \|/m);
  });
});
