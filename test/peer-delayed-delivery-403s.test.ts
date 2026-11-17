import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPeerInbox, sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';

const T0 = 1_800_000_000_000;
const PEER_TTL = 86_400_000;
let root: string, bindings: string, peers: PeerBinding[], now: number;

const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const policy = (n: number): SlackDeliveryPolicy => ({
  config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[n]!.userId, ownBotId: peers[n]!.botId,
    botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true,
  teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })),
});
const api = (n: number) => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const call: SlackCall = async (method, args = {}) => {
    calls.push({ method, args });
    if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
    if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
      is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
    if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
    if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
    if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
    throw new Error('unexpected-api-method');
  };
  return { call, posts: () => calls.filter(({ method }) => method === 'chat.postMessage') };
};
/** Every reconnect gets a fresh options object, Slack seam and policy reader. */
const connect = (n: number) => {
  const fake = api(n);
  return { ...fake, options: { bindings, busRoot: root, runsDir: root, now: () => now, call: fake.call, readPolicy: () => policy(n) } };
};

const busFile = () => join(root, 'bus-inbox', 'messages.json');
const coordinationFile = () => join(root, 'agentnet', 'coordination.json');
const inboxFor = (n: number, at: number) => {
  now = at;
  const page = readPeerInbox(session(n), 0, connect(n).options);
  if (page.status !== 'ok') throw new Error('peer inbox unavailable');
  return page.messages;
};
const sentMessage = async () => {
  const sender = connect(0);
  const sent = await sendPeerMessage({ toAgent: 'agent1', kind: 'task', text: 'Coordinate the shared context', refs: ['order:nov13'] },
    session(0), sender.options);
  expect(sent).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
  expect(sent.id).toMatch(/^peer-[a-f0-9-]{36}$/);
  expect(sender.posts()).toHaveLength(1);
  return sent.id!;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-delayed-403s-')); bindings = join(root, 'bindings.json'); now = T0;
  peers = Array.from({ length: 3 }, (_, n) => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: T0 + 2 * PEER_TTL, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('peer delivery after a cloud-agent reconnect', () => {
  it('keeps an authentic directed message readable through its remaining TTL without durable writes', async () => {
    const id = await sentMessage();
    const durable = { bus: readFileSync(busFile()), coordination: readFileSync(coordinationFile()) };

    const delayed = inboxFor(1, T0 + 1_000);
    expect(delayed.filter(m => m.envelope.id === id)).toHaveLength(1);
    expect(delayed[0]!.envelope).toMatchObject({ id, ttl: PEER_TTL - 1_000,
      body: { kind: 'peer.message', peer: { fromAgent: 'agent0', toAgent: 'agent1', kind: 'task',
        text: 'Coordinate the shared context', hopCount: 1 } } });
    expect(delayed[0]).not.toHaveProperty('originalEnvelope');

    const later = inboxFor(1, T0 + 2_000);
    expect(later.filter(m => m.envelope.id === id)).toHaveLength(1);
    expect(later[0]!.envelope.ttl).toBe(PEER_TTL - 2_000);
    expect(inboxFor(2, T0 + 2_000)).toEqual([]);

    const lastLive = inboxFor(1, T0 + PEER_TTL - 1);
    expect(lastLive).toHaveLength(1);
    expect(lastLive[0]!.envelope.ttl).toBe(1);
    expect(inboxFor(1, T0 + PEER_TTL)).toEqual([]);

    expect(readFileSync(busFile())).toEqual(durable.bus);
    expect(readFileSync(coordinationFile())).toEqual(durable.coordination);
  });

  it('rejects a delayed receipt when stored bus content no longer matches the coordination digest', async () => {
    const id = await sentMessage();
    expect(inboxFor(1, T0 + 1_000).filter(m => m.envelope.id === id)).toHaveLength(1);

    type BusStore = { rows: Array<{ receivedAt: number; envelope: { id: string; body: { peer: { text: string } } } }> };
    const originalText = readFileSync(busFile(), 'utf8');
    const store = JSON.parse(originalText) as BusStore;
    const row = store.rows.find(r => r.envelope.id === id);
    if (!row) throw new Error('posted peer receipt missing');
    row.envelope.body.peer.text = 'tampered after admission';
    writeFileSync(busFile(), JSON.stringify(store));
    expect(inboxFor(1, T0 + 1_000)).toEqual([]);

    const timing = JSON.parse(originalText) as BusStore;
    const timingRow = timing.rows.find(r => r.envelope.id === id);
    if (!timingRow) throw new Error('posted peer receipt missing');
    timingRow.receivedAt += 1;
    writeFileSync(busFile(), JSON.stringify(timing));
    expect(inboxFor(1, T0 + 1_000)).toEqual([]);
  });
});
