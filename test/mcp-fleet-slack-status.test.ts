/**
 * fleet_slack_status — read-only, argument-free MCP read of the full offline
 * Slack bridge status report (the same buildSlackBridgeStatus projection
 * `phm channels slack status --json` serves). Hermetic: in-memory transports,
 * injected reader; the config path is asserted to leave as a basename only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { projectFleetSlackBridgeStatus } from '../src/mcp/fleet-slack-status.js';
import type { SlackBridgeStatus } from '../src/core/agents/slack-status.js';

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map(c => c.close()));
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'slack-status-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

const status: SlackBridgeStatus = {
  v: 1,
  at: '2026-01-01T00:00:00.000Z',
  config: { path: '/Users/someone/.ashlr/agent-network.toml', state: 'ok' },
  slackSection: 'ok',
  bridge: { id: 'b-fake', teamId: 'T0FAKE0001', ownUserId: 'U0FAKE0001', ownBotId: 'B0FAKE0001' },
  credentials: { custody: 'phantom-secrets', botTokenRef: 'phm_slack_bot', appTokenRef: 'phm_slack_app' },
  mappings: [{ topic: 'fleet', channel: 'C0FAKE0001' }],
  teamIdentities: { slack: 2, total: 5 },
  comms: { confirmedByMason: true },
  journal: {
    state: 'ok', ingested: 3, ignored: 1, lastAt: '2026-01-01T00:00:00.000Z',
    ignoredReasons: [{ reason: 'unmapped-topic', count: 1, lastAt: '2026-01-01T00:00:00.000Z' }],
    ignoredReasonsOmitted: 0,
  },
  replies: {
    state: 'ok', answered: 1, unanswered: 1, oldestUnansweredAt: '2026-01-01T00:00:00.000Z',
    uncertainSends: 0, unverified: 0, uncertainRequests: 0, rejected: 0, futureDated: 0,
    unansweredSample: [{ channelId: 'C0FAKE0001', threadTs: '1731000000.000100', messageTs: '1731000000.000100', at: '2026-01-01T00:00:00.000Z' }],
    busFailed: 0, busFailedSample: [],
  },
  work: { asOf: '2026-01-01T00:00:00.000Z', readAt: '2026-01-01T00:00:00.000Z', inbox: 'ok', truncated: false, items: [] },
  ready: true,
  transport: { health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' },
  next: 'mapping is ready; run phm channels slack probe --json for authenticated identity, then phm channels slack run --seconds 60 --json',
};

describe('fleet_slack_status MCP tool', () => {
  it('is listed with an empty, closed input schema', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(t => t.name === 'fleet_slack_status');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    expect(tool!.description).toMatch(/no send, dispatch or merge authority/);
  });

  it('returns the full bridge status report', async () => {
    const client = await connect({ slackStatus: async () => projectFleetSlackBridgeStatus(status) });
    const result = await client.callTool({ name: 'fleet_slack_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text(result));
    expect(parsed.config.state).toBe('ok');
    expect(parsed.journal.ingested).toBe(3);
    expect(parsed.replies.answered).toBe(1);
    expect(parsed.work.inbox).toBe('ok');
    expect(parsed.transport.health).toBe('unknown');
    expect(parsed.ready).toBe(true);
  });

  it('refuses any argument', async () => {
    const client = await connect({ slackStatus: async () => status });
    for (const args of [{ root: '/tmp' }, { cwd: '.' }, { path: '/etc' }]) {
      await expect(client.callTool({ name: 'fleet_slack_status', arguments: args })).rejects.toThrow(/Invalid fleet tool arguments/);
    }
  });

  it('a throwing reader reports unknown with no counts', async () => {
    const client = await connect({ slackStatus: async () => { throw new Error('boom /Users/someone sk-secret'); } });
    const result = await client.callTool({ name: 'fleet_slack_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'slack-status-unavailable' });
    expect(text(result)).not.toMatch(/boom|sk-|Users|ingested|answered/);
  });

  it('a reader that never resolves is bounded to unknown', async () => {
    const client = await connect({ slackStatus: () => new Promise(() => {}) });
    vi.useFakeTimers();
    const pending = client.callTool({ name: 'fleet_slack_status', arguments: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'slack-status-timeout' });
  });
});

describe('projectFleetSlackBridgeStatus', () => {
  it('reduces config.path to its basename and keeps every other field verbatim', () => {
    const projected = projectFleetSlackBridgeStatus(status);
    expect(projected.config.path).toBe('agent-network.toml');
    expect(projected.config.state).toBe('ok');
    expect(projected.journal).toEqual(status.journal);
    expect(projected.replies).toEqual(status.replies);
    expect(projected.work).toEqual(status.work);
    expect(projected.credentials).toEqual(status.credentials);
    expect(projected.mappings).toEqual(status.mappings);
    expect(projected.transport).toEqual(status.transport);
    expect(projected.next).toBe(status.next);
  });
});
