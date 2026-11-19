import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentsConversationsCli } from '../src/cli/agents-conversations.js';
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
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function bus(rows: [number, string, string, string, Record<string, unknown>][] = []) {
  const root = mkdtempSync(join(tmpdir(), 'agent-conversations-'));
  roots.push(root);
  for (const [at, id, from, to, body] of rows) expect(appendBusInbox({ id, from, to, priority: 'P2', ttl: 86_400_000, body }, { root, now: () => at }).status).toBe('posted');
  return root;
}
const CHAT: [number, string, string, string, Record<string, unknown>][] = [
  [T0, 'm1', 'leader', 'claude', { text: 'can you look at the build?' }],
  [T0 + MIN, 'm2', 'claude', 'leader', { text: 'yes', replyTo: 'm1' }],
  [T0 + 2 * MIN, 'm3', 'grok', 'zai', { text: 'need the docs?' }],
];

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
