import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentsConversationsCli } from '../src/cli/agents-conversations.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildConversations, filterConversations, formatAgentConversationsText, plainAge, readAgentConversations,
  type ConversationMessage } from '../src/core/fleet/agent-conversations.js';
import { AGENT_CONVERSATIONS_PATH, createFleetLiveMapApi } from '../src/core/verse/fleet-live-map-api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), MIN = 60_000, NOW = T0 + 30 * MIN;
const say = (id: string, from: string, to: string, minute: number, over: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, from, to, kind: 'status', subject: `${id} words`, at: T0 + minute * MIN, replyTo: null, state: null, ...over });

describe('conversations from messages', () => {
  it('an empty bus has no conversations', () => {
    expect(buildConversations([], NOW)).toEqual([]);
  });

  it('a two-message thread: one thread, two people, answered', () => {
    const [c, ...more] = buildConversations([say('a', 'leader', 'claude', 0, { kind: 'ask', subject: 'build ok?' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', subject: 'yes', replyTo: 'a' })], NOW);
    expect(more).toEqual([]);
    expect(c).toMatchObject({ id: 'a', subject: 'yes', messageCount: 2, state: 'answered', stateText: 'answered', waiting: null,
      lastAt: '2026-11-18T12:01:00.000Z' });
    expect(c!.participants.map(p => p.name)).toEqual(['leader', 'claude']);
    expect(c!.messages.map(m => m.id)).toEqual(['a', 'b']);
    expect(c!.links).toEqual([{ a: 'claude', b: 'leader', count: 2, lastAt: '2026-11-18T12:01:00.000Z' }]);
  });

  it('a three-agent thread keeps every participant and a line for each pair', () => {
    const [c] = buildConversations([say('a', 'leader', 'claude', 0, { kind: 'ask' }), say('b', 'claude', 'grok', 1, { kind: 'ask', replyTo: 'a' }),
      say('c', 'grok', 'claude', 2, { kind: 'reply', replyTo: 'b' }), say('d', 'claude', 'leader', 3, { kind: 'reply', replyTo: 'a' })], NOW);
    expect(c!.participants.map(p => p.name).sort()).toEqual(['claude', 'grok', 'leader']);
    expect(c).toMatchObject({ messageCount: 4, state: 'answered' });
    expect(c!.links.map(l => `${l.a}|${l.b}|${l.count}`).sort()).toEqual(['claude|grok|2', 'claude|leader|2']);
  });

  it('a thread waiting over an hour says on whom and for how long, and is pinned first', () => {
    const later = NOW + 90 * MIN;
    const list = buildConversations([say('new', 'grok', 'claude', 100, { kind: 'status' }), say('old', 'leader', 'claude', 0, { kind: 'ask', subject: 'who owns docs?' }),
      say('mid', 'claude', 'grok', 60, { kind: 'handoff' })], later);
    expect(list.map(c => c.id)).toEqual(['old', 'mid', 'new']);
    expect(list[0]).toMatchObject({ state: 'waiting', stateText: 'waiting for reply', waiting: { on: 'claude', ms: 120 * MIN } });
    expect(plainAge(list[0]!.waiting!.ms)).toBe('2h 0m');
    expect(list[2]!.waiting).toBeNull();
  });

  it('a blocked thread is blocked, by kind or by the sender saying so', () => {
    const list = buildConversations([say('a', 'claude', 'leader', 0, { kind: 'blocker', subject: 'need access' }),
      say('b', 'grok', 'leader', 1, { kind: 'status', state: 'blocked' }), say('c', 'zai', 'leader', 2, { kind: 'status', state: 'done' })], NOW);
    expect(Object.fromEntries(list.map(c => [c.id, c.state]))).toEqual({ a: 'blocked', b: 'blocked', c: 'done' });
  });

  it('an unknown agent is kept and labelled unknown agent', () => {
    const [c] = buildConversations([say('a', 'someone', 'claude', 0, { kind: 'ask' })], NOW);
    expect(c!.participants).toEqual([{ name: 'someone', label: 'unknown agent', known: false, node: null },
      { name: 'claude', label: 'claude', known: true, node: 'lane:claude' }]);
    expect(c!.waiting?.on).toBe('claude');
    expect(formatAgentConversationsText({ schema: 'agents.conversations.v1', version: 1, generatedAt: '', source: 'available', conversations: [c!], waiting: 1, skipped: 0 }))
      .toContain('unknown agent (someone)');
  });

  it('a reply to a message that is not on the bus is kept as its own thread', () => {
    const list = buildConversations([say('r', 'claude', 'leader', 0, { kind: 'reply', replyTo: 'gone' }), say('loop', 'grok', 'leader', 1, { replyTo: 'loop' })], NOW);
    expect(list.map(c => [c.id, c.messageCount]).sort()).toEqual([['loop', 1], ['r', 1]]);
  });

  it('filters by agent and by waiting only', () => {
    const list = buildConversations([say('a', 'leader', 'claude', 0, { kind: 'ask' }), say('b', 'grok', 'zai', 1, { kind: 'status' })], NOW);
    expect(filterConversations(list, { agent: 'GROK' }).map(c => c.id)).toEqual(['b']);
    expect(filterConversations(list, { waitingOnly: true }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { agent: 'grok', waitingOnly: true })).toEqual([]);
  });

  it('an identity resolver matches every label of one agent, an unresolvable side stays strict', () => {
    const list = buildConversations([say('a', 'one', 'two', 0, { kind: 'ask' }), say('b', 'three', 'four', 1, { kind: 'status' })], NOW);
    const same = (label: string) => ['one', 'two', 'query-label'].includes(label) ? 'agt_same' : undefined;
    // 'query-label' is no participant name; only the shared identity key matches.
    expect(filterConversations(list, { agent: 'query-label' }, same).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { agent: 'query-label' })).toEqual([]);
    // A resolver that proves nothing for the query changes nothing.
    expect(filterConversations(list, { agent: 'one' }, () => undefined).map(c => c.id)).toEqual(['a']);
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function bus(rows: [number, string, string, string, Record<string, unknown>, Record<string, unknown>?][] = []) {
  const root = mkdtempSync(join(tmpdir(), 'agent-conversations-'));
  roots.push(root);
  for (const [at, id, from, to, body, extra] of rows) expect(appendBusInbox({ id, from, to, priority: 'P2', ttl: 86_400_000, body, ...extra }, { root, now: () => at }).status).toBe('posted');
  return root;
}
/** The channel metadata group every slack-coordination row carries. */
const SLACK_META = { channel: 'slack', channel_ref: 'T1/C1/1.2',
  sender: { agent_id: 'agent:peer-a', vendor: 'peer', human: false, team: true }, external: false, origin_bridge: 'remote-bridge' };
const CHAT: [number, string, string, string, Record<string, unknown>][] = [
  [T0, 'm1', 'leader', 'claude', { text: 'can you look at the build?' }],
  [T0 + MIN, 'm2', 'claude', 'leader', { text: 'yes', replyTo: 'm1' }],
  [T0 + 2 * MIN, 'm3', 'grok', 'zai', { text: 'need the docs?' }],
];

describe('v2 work threads', () => {
  const WORK: [number, string, string, string, Record<string, unknown>][] = [
    [T0, 'p1', 'peer-a', 'peer-b', { kind: 'work.post', jobId: 'RQ-PEER9', title: 'Fix the parser', repo: 'ashlrai/phantom',
      claimKeys: ['repo:ashlrai/phantom', 'queue:peer-work-abc'], dispatch: { tier: 'work', scope: 's', acceptance: 'a' } }],
    [T0 + MIN, 'p2', 'peer-b', 'peer-a', { kind: 'note', text: 'looking at it', replyTo: 'p1' }],
    [T0 + 2 * MIN, 'p3', 'peer-b', 'peer-a', { kind: 'work.result', jobId: 'RQ-PEER9', claimKey: 'queue:peer-work-abc',
      queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'failed', reason: 'tier-ceiling' }],
    [T0 + 3 * MIN, 'p4', 'peer-c', 'peer-d', { kind: 'work.post', jobId: 'RQ-PEER10', title: 'Docs pass', repo: 'ashlrai/phantom', claimKeys: ['repo:ashlrai/phantom'] }],
    [T0 + 4 * MIN, 'p5', 'peer-d', 'peer-c', { kind: 'work.result', jobId: 'RQ-PEER10', claimKey: 'repo:ashlrai/phantom',
      queueId: 'peer-work-cccccccccccccccccccccccccccccccc', receiptId: 'pw-dddddddddddddddddddddddddddddddd',
      outcome: 'complete' }],
    [T0 + 5 * MIN, 'p6', 'peer-d', 'peer-c', { kind: 'work.release', claimKey: 'repo:ashlrai/phantom', token: 'a'.repeat(64), outcome: 'completed' }],
  ];

  it('a job lifecycle is one thread by jobId, replies join it, outcomes set the state', () => {
    const result = readAgentConversations({}, { root: bus(WORK), now: () => NOW });
    const threads = Object.fromEntries(result.conversations!.map(c => [c.id, c]));
    expect(threads['job:RQ-PEER9']).toMatchObject({ messageCount: 3, state: 'blocked', stateText: 'blocked',
      subject: 'failed: tier-ceiling' });
    expect(threads['job:RQ-PEER9']!.messages.map(m => m.id)).toEqual(['p1', 'p2', 'p3']);
    // work.release carries no jobId; the claimKey resolves through the post.
    expect(threads['job:RQ-PEER10']).toMatchObject({ messageCount: 3, state: 'done' });
    expect(threads['job:RQ-PEER10']!.messages.map(m => m.id)).toEqual(['p4', 'p5', 'p6']);
    expect(result.waiting).toBe(0);
    // Claim tokens never reach the projection.
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  });

  it('the pure model buckets an explicit thread key over reply chains', () => {
    const list = buildConversations([
      say('a', 'peer-a', 'peer-b', 0, { kind: 'ask', thread: 'job:RQ-X1' }),
      say('b', 'peer-b', 'peer-a', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'peer-a', 'peer-b', 2, { kind: 'status', thread: 'job:RQ-X2' }),
    ], NOW);
    expect(list.map(x => [x.id, x.messageCount]).sort()).toEqual([['job:RQ-X1', 2], ['job:RQ-X2', 1]]);
  });
});

describe('phm agents conversations --json', () => {
  it('has a stable shape and reads the bus', () => {
    const result = readAgentConversations({}, { root: bus(CHAT), now: () => NOW });
    expect(Object.keys(result)).toEqual(['schema', 'version', 'generatedAt', 'source', 'conversations', 'waiting', 'skipped']);
    expect(result).toMatchObject({ schema: 'agents.conversations.v1', version: 1, source: 'available', waiting: 1, skipped: 0 });
    expect(Object.keys(result.conversations![0]!)).toEqual(['id', 'participants', 'subject', 'messageCount', 'lastAt', 'state', 'stateText', 'waiting', 'links', 'messages']);
    expect(result.conversations!.map(c => [c.id, c.state])).toEqual([['m3', 'waiting'], ['m1', 'answered']]);
    expect(Object.keys(result.conversations![0]!.messages[0]!)).toEqual(['id', 'at', 'from', 'to', 'kind', 'subject']);
  });

  it('an empty bus is source missing with no conversations', () => {
    expect(readAgentConversations({}, { root: bus(), now: () => NOW })).toEqual({ schema: 'agents.conversations.v1', version: 1,
      generatedAt: '2026-11-18T12:30:00.000Z', source: 'missing', conversations: [], waiting: 0, skipped: 0 });
  });

  it('matches --agent through the identity registry and stays strict without one', () => {
    const rows: [number, string, string, string, Record<string, unknown>][] = [
      [T0, 'm1', 'leader', 'agent:atlas', { text: 'can you look?' }],
      [T0 + MIN, 'm2', 'agent:atlas', 'leader', { text: 'yes', replyTo: 'm1' }],
      [T0 + 2 * MIN, 'm3', 'devin-cloud', 'grok', { text: 'alias lane note' }],
      [T0 + 3 * MIN, 'm4', 'zai', 'claude', { text: 'unrelated' }],
    ];
    const bare = bus(rows);
    // No registry: only the literal alias label matches.
    expect(readAgentConversations({ agent: 'devin-cloud' }, { root: bare, now: () => NOW }).conversations!.map(c => c.id)).toEqual(['m3']);
    const root = bus(rows);
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['devin-cloud'] }, { root }).status).toBe('created');
    // The alias finds the handle-labeled thread too; the handle finds the alias one.
    for (const agent of ['devin-cloud', 'atlas', 'agent:atlas']) {
      expect(readAgentConversations({ agent }, { root, now: () => NOW }).conversations!.map(c => c.id).sort()).toEqual(['m1', 'm3']);
    }
    // A label no identity proves still matches only itself.
    expect(readAgentConversations({ agent: 'zai' }, { root, now: () => NOW }).conversations!.map(c => c.id)).toEqual(['m4']);
  });

  it('a slack-coordination request waits for a reply; declared types set the state', () => {
    const root = bus([
      [T0, 's1', 'agent:peer-a', 'agent:peer-b', { kind: 'slack-coordination', trust: 'untrusted', messageType: 'request',
        routeMode: 'peer', text: 'can you pick up the review?' }, SLACK_META],
      [T0 + MIN, 's2', 'agent:peer-b', 'agent:peer-a', { kind: 'slack-coordination', trust: 'untrusted', messageType: 'reply',
        routeMode: 'peer', text: 'on it', inReplyTo: 'remote-9' }, { ...SLACK_META, sender: { agent_id: 'agent:peer-b', vendor: 'peer', human: false, team: true } }],
      [T0 + 2 * MIN, 's3', 'agent:peer-c', 'agent:peer-d', { kind: 'slack-coordination', trust: 'untrusted', messageType: 'status',
        routeMode: 'group', text: 'shipped the fix' }, { ...SLACK_META, channel_ref: 'T1/C1/1.3',
          sender: { agent_id: 'agent:peer-c', vendor: 'peer', human: false, team: true } }],
    ]);
    const result = readAgentConversations({}, { root, now: () => NOW });
    const threads = Object.fromEntries(result.conversations!.map(c => [c.id, c]));
    // in_reply_to is a remote correlation token, never a local envelope id, so
    // each notice roots its own thread; the declared messageType still sets
    // the state: request waits, reply answers, status is done.
    expect(threads['s1']).toMatchObject({ state: 'waiting', waiting: { on: 'peer-b' } });
    expect(threads['s2']).toMatchObject({ state: 'answered' });
    expect(threads['s3']).toMatchObject({ state: 'done' });
    expect(result.waiting).toBe(1);
  });

  it('a presence heartbeat is an observation: it forms no thread and never answers a wait', () => {
    const root = bus([
      [T0, 'a1', 'agent:nova', 'group:release:general', { kind: 'note', text: 'deploy window?' }],
      [T0 + MIN, 'p1', 'agent:nova', 'group:release:general', { kind: 'group.presence', state: 'online' }],
      [T0 + 2 * MIN, 'p2', 'agent:atlas', 'group:release:general', { kind: 'group.presence', state: 'online' }],
    ]);
    const result = readAgentConversations({}, { root, now: () => NOW });
    // Only the ask is mail: both heartbeats are excluded, so the ask still waits.
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations![0]).toMatchObject({ id: 'a1', state: 'waiting',
      messageCount: 1, waiting: { on: 'group:release:general' } });
    expect(result.waiting).toBe(1);
  });

  it('declared thread labels bucket the conversation across pairs; unlabeled mail still splits', () => {
    const root = bus([
      [T0, 'h1', 'agent:peer-a', 'agent:peer-b', { kind: 'worker-handoff', taskId: 'RQ-CHAIN9', prompt: 'Take over', thread: 't-chain' }],
      [T0 + MIN, 'h2', 'agent:peer-b', 'agent:peer-a', { kind: 'note', text: 'on it', replyTo: 'h1' }],
      [T0 + 2 * MIN, 'h3', 'agent:peer-a', 'agent:peer-b', { kind: 'note', text: 'unrelated ping' }],
      [T0 + 3 * MIN, 'h4', 'agent:peer-a', 'agent:peer-c', { kind: 'note', text: 'same label, other pair', thread: 't-chain' }],
      [T0 + 4 * MIN, 'h5', 'agent:peer-c', 'agent:peer-a', { kind: 'note', text: 'ack', thread: 't-other' }],
    ]);
    const result = readAgentConversations({}, { root, now: () => NOW });
    const threads = Object.fromEntries(result.conversations!.map(c => [c.id, c]));
    // h1 declares t-chain, h2 inherits it through replyTo and h4 shares the
    // label across a different pair: one conversation, three messages.
    expect(threads['t-chain']).toMatchObject({ messageCount: 3, state: 'answered' });
    expect(threads['t-chain']!.messages.map(m => m.id)).toEqual(['h1', 'h2', 'h4']);
    expect(threads['t-chain']!.participants.map(p => p.name).sort()).toEqual(['peer-a', 'peer-b', 'peer-c']);
    // No declared label and no reply link: the synthesized pair fallback is
    // not a thread, so h3 roots at its own id; t-other is its own bucket.
    expect(threads['h3']).toMatchObject({ messageCount: 1 });
    expect(threads['t-other']).toMatchObject({ messageCount: 1 });
  });

  it('the CLI prints that JSON, filters, and refuses unknown flags', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--json', '--waiting'])).toBe(0);
    const printed = JSON.parse(lines.pop()!);
    expect(printed.conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    expect(await run(['--agent', 'leader'])).toBe(0);
    expect(lines.pop()).toContain('answered');
    expect(await run(['--nope'])).toBe(2);
    expect(errors.pop()).toContain('Usage: phm agents conversations');
  });

  it('the API serves the same read behind a read session and checks its query', async () => {
    const root = bus(CHAT);
    const api = createFleetLiveMapApi(undefined, undefined, undefined, query => readAgentConversations(query, { root, now: () => NOW }));
    const call = async (url: string, readSession: unknown = { expiresAt: Date.now() + 60_000 }) => {
      let status = 0, body = '';
      const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (text?: string) => { body = text ?? ''; }, statusCode: 0 };
      await api({ readSession } as never, { url, headers: {} } as never, res as never, AGENT_CONVERSATIONS_PATH, 'GET');
      return { status: status || res.statusCode, body: body ? JSON.parse(body) : null };
    };
    const ok = await call(`${AGENT_CONVERSATIONS_PATH}?waiting=1`);
    expect(ok.status).toBe(200);
    expect(ok.body.conversations).toHaveLength(1);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?extra=1`)).status).toBe(400);
    expect((await call(AGENT_CONVERSATIONS_PATH, null)).status).toBe(401);
  });
});
