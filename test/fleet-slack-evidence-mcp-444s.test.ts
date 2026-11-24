/**
 * RQ-PHX-SLACKEVIDENCEMCP444S — fleet_slack_evidence: durable Slack evidence
 * bundle via the isolated fleet MCP server, through the shared
 * readSlackEvidenceBundle collector at server-owned roots. Hermetic: temp
 * roots, fake ids, in-memory transports; freshness is persisted-evidence age
 * only, never live reachability.
 */
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { parseFleetSlackEvidenceArgs, readFleetSlackEvidence, type FleetSlackEvidenceDeps } from '../src/mcp/fleet-slack-evidence.js';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';

const connections: Client[] = [];
const THREAD = '1731000000.000100';
const NOW = () => new Date('2024-11-07T18:00:00.000Z');
let root: string;
let seq = 0;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-slack-evidence-444s-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(readers: Partial<Pick<FleetReaders, 'slackEvidence'>> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'slack-evidence-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
const realReader = (deps: FleetSlackEvidenceDeps): FleetReaders['slackEvidence'] =>
  async input => readFleetSlackEvidence(input, deps);

/** Temp runs/state roots wired through the real adapter and real collector. */
function fixture(journal?: string, messages?: Record<string, unknown>) {
  const base = mkdtempSync(join(root, `fx${seq++}-`));
  const runsDir = join(base, 'runs');
  const stateRoot = join(base, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  if (journal !== undefined) writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
  if (messages !== undefined) writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return { deps: { runsDir, stateRoot, now: NOW } as FleetSlackEvidenceDeps };
}

const request = { at: '2024-11-07T12:00:00.000Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKE0001', threadTs: THREAD, messageTs: '1731000010.000100', authorId: 'UFAKE', text: 'private text',
  requestId: fakeRequestId('444s') };
const key1 = replyKey(request.requestId);
const sent = { channel: request.channelId, thread: THREAD, state: 'sent', ts: '1731000050.000100',
  digest: 'synthetic-digest', clientId: 'synthetic-client' };
const answered = { journal: `${JSON.stringify(request)}\n`, messages: { [key1]: sent } };

/** Sorted relative file list plus contents — proves the read wrote nothing. */
function snapshot(dir: string): string {
  const walk = (d: string, prefix: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}:${readFileSync(join(d, e.name), 'utf8')}`]);
  return walk(dir, '').sort().join('\n');
}

describe('fleet_slack_evidence over MCP', () => {
  it('is advertised read-only with a required thread and optional channel, message and age bound', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_slack_evidence');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['thread'], additionalProperties: false });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['thread', 'channelId', 'messageTs', 'maxAgeSeconds']);
  });

  it('dispatches validated args to the injected reader', async () => {
    const reader = vi.fn(async (input: unknown) => ({ input }));
    const client = await connect({ slackEvidence: reader });
    expect(parse(await client.callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD } })))
      .toEqual({ input: { thread: THREAD } });
    expect(parse(await client.callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD, maxAgeSeconds: 60 } })))
      .toEqual({ input: { thread: THREAD, maxAgeSeconds: 60 } });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD })).toEqual({ thread: THREAD });
    expect(parseFleetSlackEvidenceArgs({ thread: THREAD, maxAgeSeconds: 1 })).toEqual({ thread: THREAD, maxAgeSeconds: 1 });
  });

  it('returns clean persisted answered evidence verbatim through the real collector', async () => {
    const f = fixture(answered.journal, answered.messages);
    const client = await connect({ slackEvidence: realReader(f.deps) });
    const result = await client.callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD } });
    expect(result.isError).not.toBe(true);
    const out = parse(result);
    expect(out).toEqual(readSlackEvidenceBundle(THREAD, f.deps));
    expect(out).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: THREAD, asOf: NOW().toISOString(),
      sources: { journal: 'ok', sends: 'ok' } });
    expect(out.rows).toEqual([expect.objectContaining({ outcome: 'answered', ingress: 'posted', replyTs: sent.ts })]);
    expect(out.freshness).toBeUndefined();
    expect(out.scope).toContain('does not prove current runtime reachability');
    const serialized = JSON.stringify(result);
    for (const forbidden of ['UFAKE', 'private text', 'synthetic-digest', 'synthetic-client', root]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps stale freshness, degraded sources and absent evidence distinguishable', async () => {
    const old = { ...request, at: '2024-11-07T12:00:00.000Z' };
    const degraded = fixture(`${JSON.stringify(old)}\nnot-json\n`, { [key1]: sent });
    const stale = parse(await (await connect({ slackEvidence: realReader(degraded.deps) }))
      .callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD, maxAgeSeconds: 60 } }));
    expect(stale).toMatchObject({ sources: { journal: 'degraded', sends: 'ok' },
      freshness: { maxAgeSeconds: 60, verdict: 'stale' } });
    expect(stale.rows[0].outcome).toBe('answered');

    const recent = fixture(`${JSON.stringify({ ...old, at: '2024-11-07T17:59:30.000Z' })}\n`, { [key1]: sent });
    const fresh = parse(await (await connect({ slackEvidence: realReader(recent.deps) }))
      .callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD, maxAgeSeconds: 60 } }));
    expect(fresh.freshness).toMatchObject({ verdict: 'fresh' });

    const absent = fixture(undefined, undefined);
    const missing = parse(await (await connect({ slackEvidence: realReader(absent.deps) }))
      .callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD } }));
    expect(missing).toMatchObject({ sources: { journal: 'missing', sends: 'missing' }, rows: [] });
  });

  it.each([
    {}, { thread: null }, { thread: 'not-a-ts' }, { thread: '123' }, { thread: '1.2.3' },
    { thread: THREAD, maxAgeSeconds: 0 }, { thread: THREAD, maxAgeSeconds: -1 }, { thread: THREAD, maxAgeSeconds: 1.5 },
    { thread: THREAD, maxAgeSeconds: '60' }, { thread: THREAD, maxAgeSeconds: null },
    { thread: THREAD, maxAgeSeconds: 9007199254740992 },
    { thread: THREAD, root: '/tmp' }, { thread: THREAD, path: '/tmp' }, { thread: THREAD, cwd: '/tmp' },
    { thread: THREAD, runsDir: '/tmp' }, { thread: THREAD, stateRoot: '/tmp' },
    { thread: THREAD, send: true }, { thread: THREAD, enqueue: true }, { thread: THREAD, claim: true },
    { thread: THREAD, probe: true }, { thread: THREAD, now: 'x' }, { thread: THREAD, extra: 1 },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect({ slackEvidence: reader });
    await expect(client.callTool({ name: 'fleet_slack_evidence', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns fixed unavailable evidence when the collector throws, never raw detail', async () => {
    const f = fixture(answered.journal, answered.messages);
    const deps = { ...f.deps, readBundle: () => { throw new Error('private-collector-detail'); } };
    const result = await (await connect({ slackEvidence: realReader(deps) }))
      .callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD } });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: THREAD,
      asOf: NOW().toISOString(), rows: [], sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('leaves the runs/state tree untouched (read-only)', async () => {
    const f = fixture(answered.journal, answered.messages);
    const before = snapshot(root);
    const client = await connect({ slackEvidence: realReader(f.deps) });
    expect(parse(await client.callTool({ name: 'fleet_slack_evidence', arguments: { thread: THREAD, maxAgeSeconds: 60 } })).rows).toHaveLength(1);
    expect(snapshot(root)).toBe(before);
  });
});
