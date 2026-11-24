/**
 * RQ-PHX-SLACKEVIDENCEMCPCHANNEL446S — fleet_slack_evidence gains the
 * optional `channelId` argument the CLI `--channel` already supports, so a
 * shell-free agent can restrict durable Slack evidence to one channel without
 * unrelated-channel rows. Same readSlackEvidenceBundle collector, same
 * server-owned roots, same rejection of unknown keys. Hermetic: temp roots,
 * fake ids, in-memory transports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { parseFleetSlackEvidenceArgs, readFleetSlackEvidence, type FleetSlackEvidenceDeps } from '../src/mcp/fleet-slack-evidence.js';

const connections: Client[] = [];
const THREAD = '1731000000.000100';
const CHANNEL_A = 'C0FAKE0001';
const CHANNEL_B = 'C0FAKE0002';
const NOW = () => new Date('2024-11-07T18:00:00.000Z');
let root: string;
let seq = 0;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-slack-evidence-channel-446s-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(readers: Partial<Pick<FleetReaders, 'slackEvidence'>> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'slack-evidence-channel-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
const realReader = (deps: FleetSlackEvidenceDeps): FleetReaders['slackEvidence'] =>
  async input => readFleetSlackEvidence(input, deps);

/** Temp runs/state roots wired through the real adapter and real collector. */
function fixture(journal: string, messages: Record<string, unknown>) {
  const base = mkdtempSync(join(root, `fx${seq++}-`));
  const runsDir = join(base, 'runs');
  const stateRoot = join(base, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return { deps: { runsDir, stateRoot, now: NOW } as FleetSlackEvidenceDeps };
}

import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
const rid = (channelId: string, ts: string) => fakeRequestId(`446s:${channelId}:${ts}`);
const entry = (channelId: string, at: string, messageTs: string, bus?: string) => ({
  at, decision: 'ingested', ...(bus === undefined ? {} : { bus }), channelId, threadTs: THREAD, messageTs, requestId: rid(channelId, messageTs),
});
const sent = (channel: string, ts: string) => ({ channel, thread: THREAD, state: 'sent', ts });

const sharedJournal = [
  entry(CHANNEL_A, '2024-11-07T17:59:30.000Z', '1731000010.000100', 'posted'),
  entry(CHANNEL_B, '2024-11-07T12:00:00.000Z', '1731000020.000100', 'posted'),
].map(row => JSON.stringify(row)).join('\n') + '\n';
const sharedMessages = { [replyKey(rid(CHANNEL_A, '1731000010.000100'))]: sent(CHANNEL_A, '1731002390.000100') };

describe('fleet_slack_evidence channelId over MCP', () => {
  it('advertises optional channelId alongside thread and maxAgeSeconds', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_slack_evidence');
    expect(tool?.inputSchema).toMatchObject({ required: ['thread'], additionalProperties: false });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['thread', 'channelId', 'messageTs', 'maxAgeSeconds']);
    expect(tool?.inputSchema.properties?.channelId).toMatchObject({ type: 'string' });
    expect(tool?.description).toContain('channelId');
  });

  it('forwards validated channelId to the injected reader', async () => {
    const reader = vi.fn(async (input: unknown) => ({ input }));
    const client = await connect({ slackEvidence: reader });
    expect(parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, maxAgeSeconds: 60 } })))
      .toEqual({ input: { thread: THREAD, channelId: CHANNEL_A, maxAgeSeconds: 60 } });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD })).toEqual({ thread: THREAD });
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD, channelId: CHANNEL_B }))
      .toEqual({ thread: THREAD, channelId: CHANNEL_B });
  });

  it('returns only the requested channel rows with recomputed counts and freshness', async () => {
    const f = fixture(sharedJournal, sharedMessages);
    const client = await connect({ slackEvidence: realReader(f.deps) });

    const scopedA = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, maxAgeSeconds: 60 } }));
    expect(scopedA.rows).toHaveLength(1);
    expect(scopedA.rows[0]).toMatchObject({ channelId: CHANNEL_A, outcome: 'answered', ingress: 'posted' });
    expect(scopedA.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
    expect(scopedA.freshness).toMatchObject({ verdict: 'fresh', maxAgeSeconds: 60 });

    const scopedB = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_B, maxAgeSeconds: 60 } }));
    expect(scopedB.rows).toHaveLength(1);
    expect(scopedB.rows[0]).toMatchObject({ channelId: CHANNEL_B, outcome: 'unanswered' });
    expect(scopedB.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
    expect(scopedB.freshness.verdict).toBe('stale');

    const unscoped = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, maxAgeSeconds: 60 } }));
    expect(unscoped.rows.map((row: { channelId: string }) => row.channelId)).toEqual([CHANNEL_B, CHANNEL_A]);
    expect(unscoped.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 0, unanswered: 1 });
    expect(unscoped.freshness.verdict).toBe('stale');
  });

  it.each([
    { thread: THREAD, channelId: null },
    { thread: THREAD, channelId: 'bad-channel' },
    { thread: THREAD, channelId: 'c0fake0001' },
    { thread: THREAD, channelId: 42 },
    { thread: THREAD, channelId: CHANNEL_A, root: '/tmp' },
    { thread: THREAD, channelId: CHANNEL_A, runsDir: '/tmp' },
    { thread: THREAD, channelId: CHANNEL_A, send: true },
    { thread: THREAD, channel: CHANNEL_A },
  ])('rejects invalid or unknown arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect({ slackEvidence: reader });
    await expect(client.callTool({ name: 'fleet_slack_evidence', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns fixed unavailable evidence when the collector throws with channelId set', async () => {
    const f = fixture(sharedJournal, sharedMessages);
    const deps = { ...f.deps, readBundle: () => { throw new Error('private-collector-detail'); } };
    const result = await (await connect({ slackEvidence: realReader(deps) }))
      .callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD, channelId: CHANNEL_A } });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: THREAD,
      asOf: NOW().toISOString(), rows: [], sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
