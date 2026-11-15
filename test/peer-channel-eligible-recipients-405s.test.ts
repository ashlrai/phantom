import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendPeerMessage, type PeerLedgerRow } from '../src/core/agentnet/peer-bus.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';

const T0 = 1_800_000_000_000;
const PEER_TTL = 86_400_000;
const PAIR_LIMIT = 6;
let root: string, bindings: string, peers: PeerBinding[], now: number;

const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const policy = (): SlackDeliveryPolicy => ({
  config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[0]!.userId, ownBotId: peers[0]!.botId,
    botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true,
  teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })),
});
const api = () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const call: SlackCall = async (method, args = {}) => {
    calls.push({ method, args });
    if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[0]!.userId, bot_id: peers[0]!.botId };
    if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
      is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
    if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
    if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
    if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
    throw new Error('unexpected-api-method');
  };
  return { call, posts: () => calls.filter(({ method }) => method === 'chat.postMessage') };
};
const options = () => {
  const fake = api();
  return { ...fake, opts: { bindings, busRoot: root, runsDir: root, now: () => now, call: fake.call, readPolicy: () => policy() } };
};

const coordinationFile = () => join(root, 'agentnet', 'coordination.json');
const busFile = () => join(root, 'bus-inbox', 'messages.json');
const coordinationRows = (): PeerLedgerRow[] =>
  existsSync(coordinationFile()) ? JSON.parse(readFileSync(coordinationFile(), 'utf8')) as PeerLedgerRow[] : [];
const busReceiptCount = (): number => {
  if (!existsSync(busFile())) return 0;
  const store = JSON.parse(readFileSync(busFile(), 'utf8')) as { rows: unknown[] };
  return store.rows.length;
};
let debitSeq = 0;
const debitRow = (target: string): PeerLedgerRow => {
  debitSeq += 1;
  const suffix = String(debitSeq).padStart(12, '0');
  const id = `peer-00000000-0000-4000-8000-${suffix}`;
  return { id, fromAgent: 'agent0', target, origin: id, digest: 'a'.repeat(64), hopCount: 1,
    threadId: 'mesh', at: T0 };
};
const seedQuota = (target: string, count = PAIR_LIMIT) => {
  const rows = Array.from({ length: count }, () => debitRow(target));
  mkdirSync(join(root, 'agentnet'), { recursive: true, mode: 0o700 });
  writeFileSync(coordinationFile(), JSON.stringify([...coordinationRows(), ...rows]), { mode: 0o600 });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-broadcast-405s-')); bindings = join(root, 'bindings.json'); now = T0; debitSeq = 0;
  peers = [
    { callsign: 'agent0', lane: session(0).lane, sessionId: session(0).sessionId,
      sessionHash: createHash('sha256').update(JSON.stringify([session(0).lane, session(0).sessionId, session(0).token])).digest('hex'),
      expiresAt: T0 + 2 * PEER_TTL, teamId: 'TTEAM', userId: 'UAGENT0', botId: 'BAGENT0', topic: 'mesh' },
    { callsign: 'agent1', lane: session(1).lane, sessionId: session(1).sessionId,
      sessionHash: createHash('sha256').update(JSON.stringify([session(1).lane, session(1).sessionId, session(1).token])).digest('hex'),
      expiresAt: T0 + 2 * PEER_TTL, teamId: 'TTEAM', userId: 'UAGENT1', botId: 'BAGENT1', topic: 'mesh' },
    // Expired exactly at the operation clock: expiresAt > now fails.
    { callsign: 'agent2', lane: session(2).lane, sessionId: session(2).sessionId,
      sessionHash: createHash('sha256').update(JSON.stringify([session(2).lane, session(2).sessionId, session(2).token])).digest('hex'),
      expiresAt: T0, teamId: 'TTEAM', userId: 'UAGENT2', botId: 'BAGENT2', topic: 'mesh' },
    // Enrolled under another team; its Slack user id is still in the audience.
    { callsign: 'agent3', lane: session(3).lane, sessionId: session(3).sessionId,
      sessionHash: createHash('sha256').update(JSON.stringify([session(3).lane, session(3).sessionId, session(3).token])).digest('hex'),
      expiresAt: T0 + 2 * PEER_TTL, teamId: 'TOTHER', userId: 'UAGENT3', botId: 'BAGENT3', topic: 'mesh' },
  ];
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('peer channel broadcast debits only currently eligible recipients', () => {
  it('debits the channel and live same-team audience members, skipping expired and foreign-team bindings', async () => {
    // Quota spent on ineligible pairs must not block the broadcast.
    seedQuota('agent2');
    seedQuota('agent3');
    const conn = options();
    const sent = await sendPeerMessage({ channel: 'CMESH', kind: 'handoff', text: 'Coordinate the shared context', refs: ['order:nov13'] },
      session(0), conn.opts);
    expect(sent).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    expect(sent.id).toMatch(/^peer-[a-f0-9-]{36}$/);
    expect(conn.posts()).toHaveLength(1);

    const debitTargets = coordinationRows().filter(r => r.id === sent.id).map(r => r.target).sort();
    expect(debitTargets).toEqual(['CMESH', 'agent1']);
    expect(busReceiptCount()).toBe(1);
  });

  it('still refuses when a live eligible recipient pair is exhausted, with no post or bus receipt', async () => {
    seedQuota('agent1');
    const conn = options();
    const receiptsBefore = busReceiptCount();
    const sent = await sendPeerMessage({ channel: 'CMESH', kind: 'handoff', text: 'Coordinate the shared context', refs: ['order:nov13'] },
      session(0), conn.opts);
    expect(sent).toEqual({ status: 'refused', reason: 'pair-rate-limit' });
    expect(conn.posts()).toHaveLength(0);
    expect(busReceiptCount()).toBe(receiptsBefore);
  });

  it('keeps the directed path debiting only the addressed recipient', async () => {
    const conn = options();
    const sent = await sendPeerMessage({ toAgent: 'agent1', kind: 'task', text: 'Coordinate the shared context', refs: ['order:nov13'] },
      session(0), conn.opts);
    expect(sent).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    expect(conn.posts()).toHaveLength(1);
    expect(coordinationRows().filter(r => r.id === sent.id).map(r => r.target)).toEqual(['agent1']);
    expect(busReceiptCount()).toBe(1);
  });
});
