import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAgentnet } from '../src/cli/agentnet.js';
import type { PeerBinding, PeerSession } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';

const T0 = 1_800_000_000_000;
const PEER_TTL = 86_400_000;
const RECONNECT_AT = T0 + 60_000;
const SLACK_POST_TS = '1794000000.000001';

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
interface LedgerRow { id: string; fromAgent: string; target: string; origin: string; hopCount: number; threadId: string; at: number; digest: string }

let root: string, bindings: string, peers: PeerBinding[], now: number;
let oldRecipient: PeerSession, renewedRecipient: PeerSession;
const slackPosts: Array<{ via: number; method: string; args: Record<string, unknown> }> = [];
const cliOutputs: string[] = [];
const secrets: string[] = [];

const session = (n: number): PeerSession => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const hash = (s: PeerSession) => createHash('sha256').update(JSON.stringify([s.lane, s.sessionId, s.token])).digest('hex');
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
  if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
  if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
  if (method === 'chat.postMessage') {
    slackPosts.push({ via: n, method, args });
    return { channel: args.channel, ts: SLACK_POST_TS };
  }
  throw new Error('unexpected-api-method');
};
/** Every CLI invocation gets a fresh options object, Slack seam, policy reader and session. */
const connect = (sess: PeerSession, n: number) => {
  const call = api(n);
  return { session: sess, options: { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy(n) } };
};

const runCli = async (connection: ReturnType<typeof connect>, args: string[]) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await cmdAgentnet([...args, '--json'], connection.options, connection.session);
    const raw = log.mock.calls.at(-1)?.[0];
    if (typeof raw !== 'string') throw new Error('agentnet CLI emitted no JSON');
    cliOutputs.push(raw);
    return { code, json: JSON.parse(raw) as Json };
  } finally { log.mockRestore(); }
};
const readMessages = (json: Json): NonNullable<PeerReadJson['messages']> => (json as PeerReadJson).messages ?? [];
const durableBytes = () => [join(root, 'agentnet', 'coordination.json'), join(root, 'bus-inbox', 'messages.json')]
  .map(path => readFileSync(path));
const replaceRecipientBinding = (s: PeerSession) => {
  peers[1] = { ...peers[1]!, sessionId: s.sessionId, sessionHash: hash(s), expiresAt: now + 2 * PEER_TTL };
  const temp = `${bindings}.new`;
  writeFileSync(temp, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  renameSync(temp, bindings);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-renewed-reply-408s-')); bindings = join(root, 'bindings.json'); now = T0;
  slackPosts.length = 0; cliOutputs.length = 0; secrets.length = 0;
  oldRecipient = session(1);
  renewedRecipient = { lane: oldRecipient.lane, sessionId: 'session-1-renewed', token: 'synthetic-renewed-1-' + 'b'.repeat(32) };
  peers = [0, 1, 2].map(n => ({
    callsign: `agent${n}`, lane: (n === 1 ? oldRecipient : session(n)).lane,
    sessionId: (n === 1 ? oldRecipient : session(n)).sessionId,
    sessionHash: hash(n === 1 ? oldRecipient : session(n)),
    expiresAt: T0 + 2 * PEER_TTL,
    teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh',
  }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  for (const s of [session(0), oldRecipient, renewedRecipient, session(2)]) {
    secrets.push(s.token, s.sessionId, hash(s), root);
  }
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('agentnet renewed-session handoff reply', () => {
  it('round-trips an addressed handoff through a legitimately renewed recipient session', async () => {
    const sender = session(0);
    const sent = await runCli(connect(sender, 0), ['peers', 'send', 'agent1', 'handoff', 'Coordinate the renewed-session handoff']);
    expect(sent.code).toBe(0);
    const sentJson = sent.json as PeerSendJson;
    expect(sentJson).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    if (!sentJson.id) throw new Error('handoff send returned no peer id');
    const handoffId = sentJson.id;
    expect(handoffId).toMatch(/^peer-[a-f0-9-]{36}$/);
    expect(sentJson.origin).toBe(handoffId);
    expect(slackPosts).toHaveLength(1);
    const durableAfterSend = durableBytes();

    // Legitimate renewal: same callsign, lane, team identity; new sessionId/token/hash, atomically swapped in.
    replaceRecipientBinding(renewedRecipient);

    // The stale session is refused on both read and reply: no post, no durable mutation.
    const staleRead = await runCli(connect(oldRecipient, 1), ['peers', 'read', '--after', '0']);
    expect(staleRead.code).toBe(1);
    expect((staleRead.json as PeerSendJson).status).toBe('refused');
    const staleReply = await runCli(connect(oldRecipient, 1), ['peers', 'send', 'agent0', 'review', 'Stale session attempt',
      '--reply-to', handoffId]);
    expect(staleReply.code).toBe(1);
    expect((staleReply.json as PeerSendJson).status).toBe('refused');
    expect(slackPosts).toHaveLength(1);
    expect(durableBytes()).toEqual(durableAfterSend);

    now = RECONNECT_AT;
    // Recipient isolation: neither the sender nor an unrelated enrolled peer sees the inbound handoff.
    for (const [sess, n] of [[sender, 0], [session(2), 2]] as const) {
      const isolated = await runCli(connect(sess, n), ['peers', 'read', '--after', '0']);
      expect(isolated.code).toBe(0);
      expect(readMessages(isolated.json)).toEqual([]);
    }

    const received = await runCli(connect(renewedRecipient, 1), ['peers', 'read', '--after', '0']);
    expect(received.code).toBe(0);
    const receivedJson = received.json as PeerReadJson;
    expect(receivedJson.status).toBe('ok');
    expect(readMessages(received.json)).toHaveLength(1);
    const receivedEnvelope = readMessages(received.json)[0]!.envelope;
    expect(receivedEnvelope.id).toBe(handoffId);
    expect(receivedEnvelope.ttl).toBe(PEER_TTL - (RECONNECT_AT - T0));
    expect(receivedEnvelope.body?.peer).toMatchObject({ fromAgent: 'agent0', toAgent: 'agent1', kind: 'handoff',
      text: 'Coordinate the renewed-session handoff', threadId: handoffId, origin: handoffId, hopCount: 1 });
    const nextCursor = receivedJson.nextCursor;
    if (nextCursor === undefined) throw new Error('peer read returned no nextCursor');

    // Cursor replay returns the same page; advancing past it returns nothing.
    const replay = await runCli(connect(renewedRecipient, 1), ['peers', 'read', '--after', '0']);
    expect(readMessages(replay.json).map(m => m.envelope.id)).toEqual([handoffId]);
    const advanced = await runCli(connect(renewedRecipient, 1), ['peers', 'read', '--after', String(nextCursor)]);
    expect(readMessages(advanced.json)).toEqual([]);

    const replied = await runCli(connect(renewedRecipient, 1), ['peers', 'send', 'agent0', 'review',
      'Renewed session acknowledges the handoff', '--reply-to', handoffId]);
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
      expect(post.args).toMatchObject({ channel: 'CMESH' });
      return JSON.parse(post.args['text'] as string) as PostedPeer;
    });
    expect(postedPeers[1]).toMatchObject({ fromAgent: 'agent1', toAgent: 'agent0', kind: 'review',
      text: 'Renewed session acknowledges the handoff', threadId: handoffId, origin: handoffId, hopCount: 2 });

    // The sender reads the reply through the CLI; readPeerInbox only surfaces envelopes whose
    // bus receipt digest and receivedAt match a live coordination-ledger row, so this proves
    // stored receipt linkage rather than fixture output.
    now += 1_000;
    const senderRead = await runCli(connect(sender, 0), ['peers', 'read', '--after', '0']);
    expect(senderRead.code).toBe(0);
    const senderMessages = readMessages(senderRead.json);
    expect(senderMessages).toHaveLength(1);
    expect(senderMessages[0]!.envelope.id).toBe(replyId);
    expect(senderMessages[0]!.envelope.body?.peer).toMatchObject({ fromAgent: 'agent1', toAgent: 'agent0', kind: 'review',
      text: 'Renewed session acknowledges the handoff', threadId: handoffId, origin: handoffId, hopCount: 2 });

    // Durable ledger rows back the observed linkage: one debit row per (sender,target) pair.
    const ledger = JSON.parse(readFileSync(join(root, 'agentnet', 'coordination.json'), 'utf8')) as LedgerRow[];
    const handoffRows = ledger.filter(r => r.id === handoffId);
    expect(handoffRows.map(r => r.target)).toEqual(['agent1']);
    expect(handoffRows[0]).toMatchObject({ fromAgent: 'agent0', origin: handoffId, hopCount: 1, threadId: handoffId });
    const replyRows = ledger.filter(r => r.id === replyId);
    expect(replyRows.map(r => r.target)).toEqual(['agent0']);
    expect(replyRows[0]).toMatchObject({ fromAgent: 'agent1', origin: handoffId, hopCount: 2, threadId: handoffId });

    // No CLI output leaks session material, identity hashes or private paths.
    for (const raw of cliOutputs) {
      for (const secret of secrets) expect(raw).not.toContain(secret);
      expect(raw).not.toContain('sessionHash');
      expect(raw).not.toContain('originalEnvelope');
    }
  }, 60_000);
});
