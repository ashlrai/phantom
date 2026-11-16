import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PEER_PAIR_LIMIT, PEER_WINDOW_MS, readPeerInbox, sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger } from '../src/core/agentnet/peer-ledger.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { useAccountHomeForTest, useProcessHomeForTest } from '../src/core/real-home.js';
import { createFleetPeerLedgerApi, VERSE_FLEET_PEER_LEDGER_PATH as PATH } from '../src/core/verse/fleet-peer-ledger-api.js';
import { handleVerseApi, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';

const T0 = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
let root = '';
const oldHome = process.env.HOME;
const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-${'a'.repeat(32)}` });

afterEach(() => {
  setMountedApiModulesForTest(null);
  useAccountHomeForTest();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

it('uses HTTP evidence from broker sends to reconnect at the directed pair boundary', async () => {
  root = mkdtempSync(join(tmpdir(), 'peer-http-retry-406s-'));
  process.env.HOME = root;
  useProcessHomeForTest();
  setMountedApiModulesForTest([]);
  let now = T0;
  const bindings = join(root, 'bindings.json');
  const peers: PeerBinding[] = [0, 1].map(n => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: T0 + 3_600_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  const connect = (n: number) => {
    const policy: SlackDeliveryPolicy = { config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[n]!.userId,
      ownBotId: peers[n]!.botId, botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
    confirmedByMason: true, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) };
    const call: SlackCall = vi.fn(async (method, args = {}) => {
      if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
      if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
      if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
      if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
      if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
      throw new Error('unexpected Slack method');
    });
    return { call, options: { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy } };
  };
  const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage');
  const receipts = () => {
    const page = listBusInboxAfter(0, 100, { root });
    if (page.status !== 'ok') throw new Error('bus inbox unreadable');
    return page.messages;
  };
  const file = join(root, 'agentnet', 'coordination.json');
  const snapshot = () => ({ listing: readdirSync(join(root, 'agentnet')).sort(), bytes: readFileSync(file) });
  const api = createFleetPeerLedgerApi({ read: pair => readPeerLedger({ busRoot: root, pair, now: () => now }) });
  const http = async (fromAgent: string, target: string) => {
    let status = 0, text = '';
    const req = { url: `${PATH}?fromAgent=${fromAgent}&target=${target}`, headers: {} } as IncomingMessage;
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const ctx = { cfg: {} as VerseApiContext['cfg'], token: 'synthetic', allowDispatch: false, fleetPeerLedgerApi: api } as VerseApiContext;
    const before = snapshot();
    expect(await handleVerseApi(ctx, req, res, PATH, 'GET')).toBe(true);
    expect(status).toBe(200);
    expect(snapshot()).toEqual(before);
    const rows = JSON.parse(before.bytes.toString()) as Array<{ digest: string; threadId: string }>;
    for (const privateValue of [root, session(0).token, session(1).token, session(0).sessionId, session(1).sessionId,
      ...peers.map(p => p.sessionHash), ...rows.flatMap(r => [r.digest, r.threadId]), 'private-message-406s']) {
      expect(text).not.toContain(privateValue);
    }
    return JSON.parse(text);
  };
  const request = { toAgent: 'agent1', kind: 'task', text: 'private-message-406s', refs: ['pr:12'] };
  for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
    now = T0 + i * 10_000;
    expect(await sendPeerMessage(request, session(0), connect(0).options)).toMatchObject({ status: 'posted', slack: 'sent' });
  }
  now = T0 + 55_000;
  const limited = await http('agent0', 'agent1');
  expect(limited).toMatchObject({ authority: 'none', status: 'ok', asOf: iso(now),
    selection: { fromAgent: 'agent0', target: 'agent1', match: 'exact' },
    pairs: [{ fromAgent: 'agent0', target: 'agent1', inWindow: PEER_PAIR_LIMIT, remaining: 0, retryAt: iso(T0 + PEER_WINDOW_MS) }] });
  const reversed = await http('agent1', 'agent0');
  expect(reversed).toMatchObject({ authority: 'none', selection: { fromAgent: 'agent1', target: 'agent0', match: 'none' }, pairs: [] });
  const retryAt = Date.parse(limited.pairs[0].retryAt as string);
  now = retryAt - 1;
  const before = { durable: snapshot(), receipts: receipts().length };
  const early = connect(0);
  expect(await sendPeerMessage(request, session(0), early.options)).toMatchObject({ status: 'refused', reason: 'pair-rate-limit' });
  expect(posts(early.call)).toHaveLength(0);
  expect(snapshot()).toEqual(before.durable);
  expect(receipts()).toHaveLength(before.receipts);
  now = retryAt;
  const retry = connect(0);
  const sent = await sendPeerMessage(request, session(0), retry.options);
  expect(sent).toMatchObject({ status: 'posted', slack: 'sent' });
  expect(posts(retry.call)).toHaveLength(1);
  expect(receipts()).toHaveLength(before.receipts + 1);
  const inbox = readPeerInbox(session(1), 0, connect(1).options);
  if (inbox.status !== 'ok') throw new Error('peer inbox unreadable');
  expect(inbox.messages.filter(m => m.envelope.id === sent.id)).toHaveLength(1);
  expect(await http('agent0', 'agent1')).toMatchObject({ authority: 'none', asOf: iso(now),
    selection: { fromAgent: 'agent0', target: 'agent1', match: 'exact' },
    pairs: [{ inWindow: PEER_PAIR_LIMIT, remaining: 0, retryAt: iso(T0 + 10_000 + PEER_WINDOW_MS) }] });
}, 20_000);
