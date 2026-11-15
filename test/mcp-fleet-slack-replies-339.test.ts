/**
 * RQ-PHX-SLACKREPLIESMCP339 — fleet_slack_replies: read-only, argument-free MCP
 * evidence of which ingested Slack requests have a same-thread `sent` receipt.
 * Hermetic: in-memory transports, injected reader.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map(c => c.close()));
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'slack-replies-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

const evidence = {
  asOf: '2026-01-01T00:00:00.000Z',
  state: 'ok',
  answered: 1,
  unanswered: 1,
  oldestUnansweredAt: '2026-01-01T00:00:00.000Z',
  uncertainSends: 0,
  rejected: 0,
  futureDated: 0,
  unansweredSample: [{ channelId: 'C0FAKE0001', threadTs: '1731000000.000100', messageTs: '1731000000.000100', at: '2026-01-01T00:00:00.000Z' }],
};

describe('fleet_slack_replies MCP tool', () => {
  it('is listed with an empty, closed input schema', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(t => t.name === 'fleet_slack_replies');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    expect(tool!.description).toMatch(/no send, dispatch or merge authority/);
  });

  it('returns answered and unanswered counts with the sample', async () => {
    const client = await connect({ slackReplies: async () => evidence });
    const result = await client.callTool({ name: 'fleet_slack_replies', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text(result));
    expect(parsed).toEqual(evidence);
    expect(parsed.answered).toBe(1);
    expect(parsed.unanswered).toBe(1);
    expect(parsed.unansweredSample[0].channelId).toBe('C0FAKE0001');
  });

  it('refuses any argument', async () => {
    const client = await connect({ slackReplies: async () => evidence });
    for (const args of [{ root: '/tmp' }, { cwd: '.' }, { limit: 1 }]) {
      await expect(client.callTool({ name: 'fleet_slack_replies', arguments: args })).rejects.toThrow(/Invalid fleet tool arguments/);
    }
  });

  it('a throwing reader reports unknown with no counts', async () => {
    const client = await connect({ slackReplies: async () => { throw new Error('boom /Users/someone sk-secret'); } });
    const result = await client.callTool({ name: 'fleet_slack_replies', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'slack-replies-unavailable' });
    expect(text(result)).not.toMatch(/boom|sk-|Users|answered/);
  });

  it('a reader that never resolves is bounded to unknown', async () => {
    const client = await connect({ slackReplies: () => new Promise(() => {}) });
    vi.useFakeTimers();
    const pending = client.callTool({ name: 'fleet_slack_replies', arguments: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'slack-replies-timeout' });
  });
});
