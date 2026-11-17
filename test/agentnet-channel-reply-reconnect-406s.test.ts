import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAgentnet } from '../src/cli/agentnet.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { slackThreadRef } from '../src/core/agents/slack-network.js';

const T0 = 1_800_000_000_000;
const PEER_TTL = 86_400_000;
const RECONNECT_AT = T0 + 60_000;
const SLACK_POST_TS = '1794000000.000001';
const SLACK_THREAD_TS = '1793999999.000001';
const SLACK_THREAD_REF = slackThreadRef('TTEAM', 'CMESH', SLACK_THREAD_TS);

type Json = Record<string, unknown>;
interface PeerMessage {
  fromAgent?: string; toAgent?: string; channel?: string; kind?: string; text?: string;
  threadId?: string; origin?: string; hopCount?: number;
}
interface PeerReadJson {
  status?: string; nextCursor?: number;
  messages?: Array<{ cursor: number; receivedAt: number; envelope: {
    id: string; ttl: number; to?: string; from?: string;
    body?: { kind?: string; peer?: PeerMessage };
  } }>;
}
interface PeerSendJson { status?: string; reason?: string; id?: string; origin?: string; hopCount?: number; slack?: string }
interface PostedPeer { fromAgent?: string; toAgent?: string; channel?: string; kind?: string; text?: string; threadId?: string; origin?: string; hopCount?: number }

let root: string, bindings: string, peers: PeerBinding[], now: number;
const slackPosts: Array<{ via: number; method: string; args: Record<string, unknown> }> = [];

const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const policy = (n: number): SlackDeliveryPolicy => ({
  config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[n]!.userId, ownBotId: peers[n]!.botId,
    botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true,
  teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })),
});
const api = (n: number): SlackCall => async (method, args = {}) => {
  if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
  if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
    is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
  if (method === 'conversations.members') return { members: peers.filter(p => p.callsign !== 'agent2').map(p => p.userId) };
  if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
  if (method === 'chat.postMessage') {
    slackPosts.push({ via: n, method, args });
    return { channel: args.channel, ts: SLACK_POST_TS };
  }
  throw new Error('unexpected-api-method');
};
/** Every reconnect gets a fresh options object, Slack seam, policy reader and session. */
const connect = (n: number) => {
  const call = api(n);
  return { session: session(n), options: { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy(n) } };
};

const runCli = async (connection: ReturnType<typeof connect>, args: string[]) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await cmdAgentnet([...args, '--json'], connection.options, connection.session);
    const raw = log.mock.calls.at(-1)?.[0];
    if (typeof raw !== 'string') throw new Error('agentnet CLI emitted no JSON');
    return { code, json: JSON.parse(raw) as Json };
  } finally { log.mockRestore(); }
};
const readMessages = (json: Json): NonNullable<PeerReadJson['messages']> => (json as PeerReadJson).messages ?? [];
const durableBytes = () => [join(root, 'agentnet', 'coordination.json'), join(root, 'bus-inbox', 'messages.json')]
  .map(path => readFileSync(path));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-channel-reply-406s-')); bindings = join(root, 'bindings.json'); now = T0;
  slackPosts.length = 0;
  peers = [0, 1, 2, 3, 4].map(n => ({
    callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    // agent2 stays enrolled but is absent from conversations.members; agent3 is expired at T0.
    expiresAt: n === 3 ? T0 : T0 + 2 * PEER_TTL,
    teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh',
  }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('agentnet channel handoff reconnect reply', () => {
  it('round-trips a delayed CLI channel read and receipt-linked reply without widening the audience', async () => {
    const sent = await runCli(connect(0), ['peers', 'send', '#CMESH', 'handoff', 'Coordinate the shared context', '--thread', SLACK_THREAD_REF]);
    expect(sent.code).toBe(0);
    const sentJson = sent.json as PeerSendJson;
    expect(sentJson).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    if (!sentJson.id) throw new Error('channel send returned no peer id');
    const handoffId = sentJson.id;
    expect(handoffId).toMatch(/^peer-[a-f0-9-]{36}$/);
    expect(sentJson.origin).toBe(handoffId);
    expect(slackPosts).toHaveLength(1);
    const durableAfterSend = durableBytes();

    now = RECONNECT_AT;
    const received = await runCli(connect(1), ['peers', 'read', '--after', '0']);
    expect(received.code).toBe(0);
    const receivedJson = received.json as PeerReadJson;
    expect(receivedJson.status).toBe('ok');
    expect(readMessages(received.json)).toHaveLength(1);
    const receivedEnvelope = readMessages(received.json)[0]!.envelope;
    const returnedId = receivedEnvelope.id;
    expect(returnedId).toBe(handoffId);
    expect(receivedEnvelope.ttl).toBe(PEER_TTL - (RECONNECT_AT - T0));
    expect(receivedEnvelope.body?.peer).toMatchObject({ fromAgent: 'agent0', channel: 'CMESH', kind: 'handoff',
      text: 'Coordinate the shared context', threadId: SLACK_THREAD_REF, origin: handoffId, hopCount: 1 });
    const returnedThread = receivedEnvelope.body?.peer?.threadId;
    if (!returnedThread) throw new Error('channel handoff returned no thread');

    const secondEligible = await runCli(connect(4), ['peers', 'read', '--after', '0']);
    expect(secondEligible.code).toBe(0);
    expect(readMessages(secondEligible.json).filter(m => m.envelope.id === handoffId)).toHaveLength(1);
    const outsideAudience = await runCli(connect(2), ['peers', 'read', '--after', '0']);
    expect(outsideAudience.code).toBe(0);
    expect(readMessages(outsideAudience.json)).toEqual([]);
    const senderBeforeReply = await runCli(connect(0), ['peers', 'read', '--after', '0']);
    expect(senderBeforeReply.code).toBe(0);
    expect(readMessages(senderBeforeReply.json)).toEqual([]);
    expect(durableBytes()).toEqual(durableAfterSend);

    const replied = await runCli(connect(1), ['peers', 'send', 'agent0', 'review', 'Reply with the coordinated result',
      '--reply-to', returnedId, '--thread', returnedThread]);
    expect(replied.code).toBe(0);
    const repliedJson = replied.json as PeerSendJson;
    expect(repliedJson).toMatchObject({ status: 'posted', slack: 'sent', origin: handoffId, hopCount: 2 });
    if (!repliedJson.id) throw new Error('peer reply returned no id');
    const replyId = repliedJson.id;
    expect(replyId).toMatch(/^peer-[a-f0-9-]{36}$/);
    expect(replyId).not.toBe(handoffId);

    expect(slackPosts).toHaveLength(2);
    expect(slackPosts.map(post => post.via)).toEqual([0, 1]);
    const postedPeers = slackPosts.map(post => {
      expect(post.method).toBe('chat.postMessage');
      expect(post.args).toMatchObject({ channel: 'CMESH', thread_ts: SLACK_THREAD_TS });
      return JSON.parse(post.args['text'] as string) as PostedPeer;
    });
    expect(postedPeers[0]).toMatchObject({ fromAgent: 'agent0', channel: 'CMESH', kind: 'handoff',
      text: 'Coordinate the shared context', threadId: SLACK_THREAD_REF, origin: handoffId, hopCount: 1 });
    expect(postedPeers[1]).toMatchObject({ fromAgent: 'agent1', toAgent: 'agent0', kind: 'review',
      text: 'Reply with the coordinated result', threadId: SLACK_THREAD_REF, origin: handoffId, hopCount: 2 });

    now += 1_000;
    const senderRead = await runCli(connect(0), ['peers', 'read', '--after', '0']);
    expect(senderRead.code).toBe(0);
    const senderMessages = readMessages(senderRead.json);
    expect(senderMessages).toHaveLength(1);
    expect(senderMessages[0]!.envelope.id).toBe(replyId);
    expect(senderMessages[0]!.envelope.body?.peer).toMatchObject({ fromAgent: 'agent1', toAgent: 'agent0', kind: 'review',
      text: 'Reply with the coordinated result', threadId: SLACK_THREAD_REF, origin: handoffId, hopCount: 2 });

    const durableAfterReply = durableBytes();
    const expiredRead = await runCli(connect(3), ['peers', 'read', '--after', '0']);
    expect(expiredRead.code).toBe(1);
    expect((expiredRead.json as PeerSendJson).status).toBe('refused');
    const expiredReply = await runCli(connect(3), ['peers', 'send', 'agent0', 'review', 'Expired peer attempt',
      '--reply-to', handoffId, '--thread', returnedThread]);
    expect(expiredReply.code).toBe(1);
    expect((expiredReply.json as PeerSendJson).status).toBe('refused');
    expect(durableBytes()).toEqual(durableAfterReply);
    expect(slackPosts).toHaveLength(2);
  });
});
