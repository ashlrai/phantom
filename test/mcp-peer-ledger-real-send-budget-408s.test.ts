import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { PEER_PAIR_LIMIT, PEER_WINDOW_MS, sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { readFleetPeerLedger } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const T0 = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-${'a'.repeat(32)}` });

it('uses fresh MCP evidence to resume a real pair send at its window boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-mcp-408s-'));
  let now = T0;
  const bindings = join(root, 'bindings.json');
  const peers: PeerBinding[] = [0, 1, 2].map(n => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: T0 + 3_600_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  const policy: SlackDeliveryPolicy = { config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[0]!.userId,
    ownBotId: peers[0]!.botId, botTokenRef: 'phm_SYNTHETIC_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) };
  const call: SlackCall = vi.fn(async (method, args = {}) => {
    if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[0]!.userId, bot_id: peers[0]!.botId };
    if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
    if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
    if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
    if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
    throw new Error('unexpected Slack method');
  });
  const options = { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy };
  let sequence = 0;
  const send = (toAgent: string) => sendPeerMessage({ toAgent, kind: 'task', text: 'private-message-408s',
    threadId: `private-thread-408s-${++sequence}`, refs: [] }, session(0), options);
  const posts = () => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage').length;
  const file = join(root, 'agentnet', 'coordination.json');
  // Snapshot every file under the private root, including the bus and Slack state.
  const snapshot = (dir = root): Array<[string, string]> => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[path, readFileSync(path).toString('base64')] as [string, string]];
  }).sort(([a], [b]) => a.localeCompare(b));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    peerLedger: input => readFleetPeerLedger({ ...input, read: pair => readPeerLedger({ busRoot: root, pair, now: () => now }) }) });
  const client = new Client({ name: 'peer-mcp-408s', version: '1.0.0' });
  try {
    await server.connect(st);
    await client.connect(ct);
    const report = async (target: string) => {
      const before = snapshot();
      const result = await client.callTool({ name: 'fleet_peer_ledger', arguments: { fromAgent: 'agent0', target } });
      expect(result.isError).not.toBe(true);
      expect(snapshot()).toEqual(before);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ digest: string; threadId: string }>;
      for (const value of [root, bindings, 'private-message-408s', 'phm_SYNTHETIC_BOT_TOKEN',
        ...[0, 1, 2].flatMap(n => [session(n).token, session(n).sessionId, peers[n]!.sessionHash]),
        ...rows.flatMap(row => [row.digest, row.threadId])]) expect(text).not.toContain(value);
      const value = JSON.parse(text) as PeerLedgerReport;
      expect(value).toMatchObject({ authority: 'none', status: 'ok', asOf: iso(now),
        selection: { fromAgent: 'agent0', target, match: 'exact' } });
      return value;
    };
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      now = T0 + i * 10_000;
      expect(await send('agent1')).toMatchObject({ status: 'posted', slack: 'sent' });
    }
    expect(await send('agent2')).toMatchObject({ status: 'posted', slack: 'sent' });
    const limited = await report('agent1');
    expect(limited.pairs).toMatchObject([{ inWindow: PEER_PAIR_LIMIT, remaining: 0, retryAt: iso(T0 + PEER_WINDOW_MS) }]);
    expect((await report('agent2')).pairs).toMatchObject([{ inWindow: 1, remaining: PEER_PAIR_LIMIT - 1, retryAt: null }]);
    const retryAt = Date.parse(limited.pairs[0]!.retryAt!);
    now = retryAt - 1;
    expect((await report('agent1')).pairs[0]).toMatchObject({ remaining: 0, retryAt: iso(retryAt) });
    const before = snapshot(), beforePosts = posts();
    expect(await send('agent1')).toMatchObject({ status: 'refused', reason: 'pair-rate-limit' });
    expect(posts()).toBe(beforePosts);
    expect(snapshot()).toEqual(before);
    now = retryAt;
    expect((await report('agent1')).pairs[0]).toMatchObject({ inWindow: PEER_PAIR_LIMIT - 1, remaining: 1, retryAt: null });
    expect((await report('agent2')).pairs[0]).toMatchObject({ inWindow: 1, remaining: PEER_PAIR_LIMIT - 1, retryAt: null });
    expect(await send('agent1')).toMatchObject({ status: 'posted', slack: 'sent' });
    expect(posts()).toBe(beforePosts + 1);
    expect((await report('agent1')).pairs[0]).toMatchObject({ inWindow: PEER_PAIR_LIMIT, remaining: 0,
      retryAt: iso(T0 + 10_000 + PEER_WINDOW_MS) });
    expect((await report('agent2')).pairs[0]).toMatchObject({ inWindow: 1, remaining: PEER_PAIR_LIMIT - 1, retryAt: null });
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
