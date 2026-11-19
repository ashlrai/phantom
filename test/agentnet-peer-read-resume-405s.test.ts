import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdAgentnet } from '../src/cli/agentnet.js';
import { sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));

const root = mkdtempSync(join(tmpdir(), 'peer-resume-'));
const bindings = join(root, 'bindings.json');
const start = 1_794_000_000_000;
let now = start;
const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-${'a'.repeat(32)}` });
const peers: PeerBinding[] = Array.from({ length: 3 }, (_, n) => ({
  callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
  sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
  expiresAt: start + 2 * 86_400_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh',
}));
const policy: SlackDeliveryPolicy = { config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[0]!.userId,
  ownBotId: peers[0]!.botId, botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) };
const call: SlackCall = async (method, args = {}) => {
  if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[0]!.userId, bot_id: peers[0]!.botId };
  if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
  if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
  if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
  if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
  throw new Error('unexpected-api-method');
};
const options = { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy };
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('resumes the CLI across filtered pages without consuming authenticated handoffs', async () => {
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  const envelope = { id: 'unrelated-0', from: 'other', to: 'other', priority: 'P2', ttl: 86_400_000,
    body: { kind: 'note', text: 'unrelated' } };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  // Seed a valid private snapshot to exercise a full bus page without 100 disk transactions.
  writeFileSync(join(root, 'bus-inbox/messages.json'), JSON.stringify({ version: 2, highWater: 100,
    rows: Array.from({ length: 100 }, (_, n) => ({ cursor: n + 1, receivedAt: now,
      envelope: { ...envelope, id: `unrelated-${n}` } })) }), { mode: 0o600 });
  const handoff = await sendPeerMessage({ toAgent: 'agent1', kind: 'handoff', text: 'Continue review' }, session(0), options);
  expect(handoff).toMatchObject({ status: 'posted', slack: 'sent' });
  const other = await sendPeerMessage({ toAgent: 'agent2', kind: 'handoff', text: 'Other recipient' }, session(0), options);
  expect(other).toMatchObject({ status: 'posted', slack: 'sent' });
  const source = listBusInboxAfter(100, 100, { root, now: () => now });
  if (source.status !== 'ok') throw new Error('missing fixture');
  expect(appendBusInbox({ ...source.messages[0]!.envelope, id: 'forged-peer' }, { root, now: () => now }).status).toBe('posted');
  const paths = [bindings, join(root, 'agentnet/coordination.json'), join(root, 'bus-inbox/messages.json')];
  const before = paths.map(path => readFileSync(path));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = async (cursor: number) => {
    expect(await cmdAgentnet(['peers', 'read', '--after', String(cursor), '--json'], options, session(1))).toBe(0);
    const raw = log.mock.calls.at(-1)![0] as string;
    for (const peer of [session(0), session(1), session(2)]) {
      expect(raw).not.toContain(peer.token);
      expect(raw).not.toContain(peer.sessionId);
    }
    expect(raw).not.toContain('originalEnvelope');
    return JSON.parse(raw) as { status: string; nextCursor: number; messages: Array<{ cursor: number; envelope: { id: string; ttl: number } }> };
  };
  now += 12_345;
  const first = await read(0);
  expect(first).toEqual({ status: 'ok', messages: [], nextCursor: 100, workResults: 'missing' });
  const second = await read(first.nextCursor);
  expect(second.status).toBe('ok');
  expect(second.nextCursor).toBe(103);
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]).toMatchObject({ cursor: 101, envelope: { id: handoff.id, ttl: 86_400_000 - 12_345 } });
  expect((await read(first.nextCursor)).messages).toEqual(second.messages);
  expect((await read(second.nextCursor)).messages).toEqual([]);
  now = start + 86_400_000;
  expect((await read(first.nextCursor)).messages).toEqual([]);
  expect(paths.map(path => readFileSync(path))).toEqual(before);
}, 120_000);
