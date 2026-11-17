/**
 * RQ-PHX-SLACKREQUESTMCP448S — fleet_slack_evidence gains the optional
 * `messageTs` argument the CLI `--message` already supports, so a shell-free
 * coordination agent can verify exactly one Slack request's durable evidence
 * without unrelated same-thread rows. Same readSlackEvidenceBundle collector,
 * same server-owned roots, same rejection of unknown keys; rows, counts and
 * freshness are recomputed for the selected channel+message only. Hermetic:
 * temp roots, fake ids, in-memory transports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { parseFleetSlackEvidenceArgs, readFleetSlackEvidence, type FleetSlackEvidenceDeps } from '../src/mcp/fleet-slack-evidence.js';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';

const connections: Client[] = [];
const THREAD = '1731000000.000100';
const CHANNEL_A = 'C0FAKE0001';
const CHANNEL_B = 'C0FAKE0002';
const TARGET_TS = '1731000010.000100';
const SIBLING_TS = '1731000020.000100';
const UNKNOWN_TS = '1731999999.000100';
const NOW = () => new Date('2024-11-07T18:00:00.000Z');
let root: string;
let seq = 0;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-slack-evidence-request-448s-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(readers: Partial<Pick<FleetReaders, 'slackEvidence'>> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'slack-evidence-request-test', version: '1.0.0' });
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
const rid = (channelId: string, ts: string) => fakeRequestId(`448s:${channelId}:${ts}`);
const entry = (channelId: string, at: string, messageTs: string, bus?: string) => ({
  at, decision: 'ingested', ...(bus === undefined ? {} : { bus }), channelId, threadTs: THREAD, messageTs, requestId: rid(channelId, messageTs),
});
const sent = (channel: string, ts: string) => ({ channel, thread: THREAD, state: 'sent', ts });

// One answered target (stale ingress), one fresh unanswered sibling in the
// same channel+thread, and a same-messageTs request in another channel.
const sharedJournal = [
  entry(CHANNEL_A, '2024-11-07T12:00:00.000Z', TARGET_TS, 'posted'),
  entry(CHANNEL_B, '2024-11-07T17:59:40.000Z', TARGET_TS, 'posted'),
  entry(CHANNEL_A, '2024-11-07T17:59:50.000Z', SIBLING_TS, 'posted'),
].map(row => JSON.stringify(row)).join('\n') + '\n';
const sharedMessages = { [replyKey(rid(CHANNEL_A, TARGET_TS))]: sent(CHANNEL_A, '1731002390.000100') };

describe('fleet_slack_evidence messageTs over MCP', () => {
  it('advertises optional messageTs alongside thread, channelId and maxAgeSeconds', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_slack_evidence');
    expect(tool?.inputSchema).toMatchObject({ required: ['thread'], additionalProperties: false });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['thread', 'channelId', 'messageTs', 'maxAgeSeconds']);
    expect(tool?.inputSchema.properties?.messageTs).toMatchObject({ type: 'string' });
    expect(tool?.description).toContain('messageTs');
  });

  it('forwards validated messageTs to the injected reader', async () => {
    const reader = vi.fn(async (input: unknown) => ({ input }));
    const client = await connect({ slackEvidence: reader });
    expect(parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, maxAgeSeconds: 60 } })))
      .toEqual({ input: { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, maxAgeSeconds: 60 } });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS }))
      .toEqual({ thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS });
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD, messageTs: TARGET_TS })).toBeNull();
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD, channelId: CHANNEL_A, messageTs: 'bad' })).toBeNull();
  });

  it('selects exactly the requested request with recomputed counts and freshness', async () => {
    const f = fixture(sharedJournal, sharedMessages);
    const client = await connect({ slackEvidence: realReader(f.deps) });

    const target = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, maxAgeSeconds: 60 } }));
    expect(target.selection).toEqual({ channelId: CHANNEL_A, messageTs: TARGET_TS });
    expect(target.rows).toHaveLength(1);
    expect(target.rows[0]).toMatchObject({ channelId: CHANNEL_A, messageTs: TARGET_TS,
      outcome: 'answered', ingress: 'posted' });
    expect(target.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
    // The selected row is stale even though fresh siblings exist in the thread.
    expect(target.freshness).toMatchObject({ verdict: 'stale', maxAgeSeconds: 60 });

    const sibling = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, messageTs: SIBLING_TS, maxAgeSeconds: 60 } }));
    expect(sibling.rows).toHaveLength(1);
    expect(sibling.rows[0]).toMatchObject({ channelId: CHANNEL_A, messageTs: SIBLING_TS, outcome: 'unanswered' });
    expect(sibling.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
    expect(sibling.freshness.verdict).toBe('fresh');
  });

  it('scopes the same messageTs per channel and never borrows another request', async () => {
    const f = fixture(sharedJournal, sharedMessages);
    const client = await connect({ slackEvidence: realReader(f.deps) });

    // The same timestamp exists in CHANNEL_B; selecting channel A returns only A.
    const other = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_B, messageTs: TARGET_TS, maxAgeSeconds: 60 } }));
    expect(other.rows).toHaveLength(1);
    expect(other.rows[0]).toMatchObject({ channelId: CHANNEL_B, messageTs: TARGET_TS, outcome: 'unanswered' });
    expect(other.counts.answered).toBe(0);
    expect(other.freshness.verdict).toBe('fresh');

    const unknown = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, messageTs: UNKNOWN_TS, maxAgeSeconds: 60 } }));
    expect(unknown.selection).toEqual({ channelId: CHANNEL_A, messageTs: UNKNOWN_TS });
    expect(unknown.rows).toEqual([]);
    expect(unknown.counts).toEqual({ total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 });
    expect(unknown.freshness).toMatchObject({ verdict: 'unknown', maxAgeSeconds: 60 });
    expect(unknown.sources).toEqual({ journal: 'ok', sends: 'ok' });
  });

  it('omits freshness when no bound is requested and preserves unscoped output without messageTs', async () => {
    const f = fixture(sharedJournal, sharedMessages);
    const client = await connect({ slackEvidence: realReader(f.deps) });

    const noBound = parse(await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS } }));
    expect(noBound.rows).toHaveLength(1);
    expect(noBound.selection).toEqual({ channelId: CHANNEL_A, messageTs: TARGET_TS });
    expect(noBound.freshness).toBeUndefined();

    const unscoped = parse(await client.callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD } }));
    expect(unscoped).toEqual(readSlackEvidenceBundle(THREAD, f.deps));
    expect(unscoped.selection).toBeUndefined();
    expect(unscoped.rows).toHaveLength(3);
    expect(unscoped.counts).toEqual({ total: 3, answered: 1, uncertain: 0, busFailed: 0, unanswered: 2 });
  });

  it.each([
    { thread: THREAD, messageTs: TARGET_TS },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: 'bad' },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: '1.2.3' },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: '1731000010' },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: 42 },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: null },
    { thread: THREAD, channelId: 'bad-channel', messageTs: TARGET_TS },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, root: '/tmp' },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, runsDir: '/tmp' },
    { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, send: true },
    { thread: THREAD, channelId: CHANNEL_A, message: TARGET_TS },
  ])('rejects invalid or unknown arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect({ slackEvidence: reader });
    await expect(client.callTool({ name: 'fleet_slack_evidence', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns fixed unavailable evidence with the requested selection when the collector throws', async () => {
    const f = fixture(sharedJournal, sharedMessages);
    const deps = { ...f.deps, readBundle: () => { throw new Error('private-collector-detail'); } };
    const client = await connect({ slackEvidence: realReader(deps) });
    const result = await client.callTool({ name: 'fleet_slack_evidence',
      arguments: { thread: THREAD, channelId: CHANNEL_A, messageTs: TARGET_TS, maxAgeSeconds: 60 } });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: THREAD,
      selection: { channelId: CHANNEL_A, messageTs: TARGET_TS },
      asOf: NOW().toISOString(), rows: [], sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
    expect(JSON.stringify(result)).not.toContain(root);

    const unselected = await client.callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD } });
    expect(parse(unselected).selection).toBeUndefined();
  });
});
