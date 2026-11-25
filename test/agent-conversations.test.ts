import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentsConversationsCli } from '../src/cli/agents-conversations.js';
import { createAgentChannel, registerAgentIdentity } from '../src/core/agents/bus-identity.js';
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
    expect(formatAgentConversationsText({ schema: 'agents.conversations.v1', version: 1, generatedAt: '', source: 'available', conversations: [c!], matched: 1, waiting: 1, skipped: 0 }))
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

  it('filters to blocked threads only and composes with the other filters', () => {
    const list = buildConversations([
      say('a', 'claude', 'leader', 0, { kind: 'blocker', subject: 'need access' }),
      say('b', 'leader', 'claude', 1, { kind: 'ask', subject: 'build ok?' }),
      say('c', 'grok', 'zai', 2, { kind: 'status', state: 'blocked', subject: 'quota out' }),
      say('d', 'zai', 'grok', 3, { kind: 'reply', replyTo: 'c' }),
    ], NOW);
    // 'a' is blocked by kind; 'c'+'d' is answered; 'b' waits — only 'a' stays.
    expect(filterConversations(list, { blockedOnly: true }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { blockedOnly: true, agent: 'claude' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { blockedOnly: true, agent: 'grok' })).toEqual([]);
    // A thread cannot be both waiting and blocked: the intersection is empty.
    expect(filterConversations(list, { blockedOnly: true, waitingOnly: true })).toEqual([]);
  });

  it('state keeps threads in one state and composes conjunctively with the shortcuts', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask', subject: 'build ok?' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'grok', 'zai', 2, { kind: 'blocker', subject: 'need access' }),
      say('d', 'zai', 'grok', 3, { kind: 'status', state: 'done', subject: 'shipped' }),
      say('e', 'peer', 'zai', 4, { kind: 'status', subject: 'fyi' }),
    ], NOW);
    // 'a'+'b' is answered, 'c' blocked, 'd' done, 'e' done — one state each.
    expect(filterConversations(list, { state: 'answered' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { state: 'blocked' }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { state: 'done' }).map(c => c.id).sort()).toEqual(['d', 'e']);
    expect(filterConversations(list, { state: 'waiting' })).toEqual([]);
    // The shortcuts stay conjunctive: --state answered + --waiting is empty,
    // --state blocked agrees with --blocked.
    expect(filterConversations(list, { state: 'answered', waitingOnly: true })).toEqual([]);
    expect(filterConversations(list, { state: 'blocked', blockedOnly: true }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { state: 'answered', agent: 'claude' }).map(c => c.id)).toEqual(['a']);
  });

  it('since keeps whole threads whose last activity reaches the cutoff', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'grok', 'zai', 4, { kind: 'ask' }),
      say('d', 'zai', 'grok', 5, { kind: 'reply', replyTo: 'c' }),
    ], NOW);
    // 'a' last spoke at minute 1, 'c' at minute 5; NOW is minute 30.
    const recent = filterConversations(list, { since: T0 + 3 * MIN });
    expect(recent.map(c => c.id)).toEqual(['c']);
    // The whole thread stays — its minute-4 opener is not trimmed by the cutoff.
    expect(recent[0]!.messageCount).toBe(2);
    // Inclusive: lastAt equal to the cutoff stays; one minute later drops.
    expect(filterConversations(list, { since: T0 + 5 * MIN }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { since: T0 + 6 * MIN })).toEqual([]);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { since: T0 + 3 * MIN, state: 'answered' }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { since: T0 + 3 * MIN, agent: 'leader' })).toEqual([]);
  });

  it('before keeps whole threads whose last activity precedes the cutoff, composing with since into one window', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'grok', 'zai', 4, { kind: 'ask' }),
      say('d', 'zai', 'grok', 5, { kind: 'reply', replyTo: 'c' }),
    ], NOW);
    // 'a' last spoke at minute 1, 'c' at minute 5.
    const older = filterConversations(list, { before: T0 + 3 * MIN });
    expect(older.map(c => c.id)).toEqual(['a']);
    // The whole thread stays — its minute-0 opener is not trimmed by the cutoff.
    expect(older[0]!.messageCount).toBe(2);
    // Exclusive: 'c' last spoke exactly at minute 5, so a cutoff there drops
    // it while 'a' stays; one minute later both stay.
    expect(filterConversations(list, { before: T0 + 5 * MIN }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { before: T0 + 6 * MIN }).map(c => c.id).sort()).toEqual(['a', 'c']);
    // since/before read one [since, before) window: a thread stamped exactly
    // at either bound never matches, and an inverted window is an honest empty.
    expect(filterConversations(list, { since: T0 + MIN, before: T0 + 5 * MIN }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { since: T0 + 5 * MIN, before: T0 + 5 * MIN })).toEqual([]);
    expect(filterConversations(list, { since: T0 + 6 * MIN, before: T0 + 3 * MIN })).toEqual([]);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { before: T0 + 3 * MIN, state: 'answered' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { before: T0 + 3 * MIN, agent: 'grok' })).toEqual([]);
  });

  it('contains keeps whole threads where any member subject carries the needle', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask', subject: 'fix the parser crash' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a', subject: 'on it' }),
      say('c', 'grok', 'zai', 2, { kind: 'status', subject: 'docs  pass   done' }),
      say('d', 'zai', 'grok', 3, { kind: 'reply', replyTo: 'c', subject: 'ack' }),
    ], NOW);
    // Any member subject matches — 'b' alone would not carry it, the pair still does via 'a'.
    expect(filterConversations(list, { contains: 'parser' }).map(c => c.id)).toEqual(['a']);
    // Case-insensitive, whitespace collapsed on both sides.
    expect(filterConversations(list, { contains: 'DOCS   PASS' }).map(c => c.id)).toEqual(['c']);
    // Whole threads, never partial message lists: both members stay.
    const [thread] = filterConversations(list, { contains: 'parser' });
    expect(thread!.messageCount).toBe(2);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { contains: 'parser', state: 'answered' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { contains: 'parser', agent: 'grok' })).toEqual([]);
    // A needle that normalizes to nothing imposes no constraint; no match is an honest empty.
    expect(filterConversations(list, { contains: '   ' })).toHaveLength(2);
    expect(filterConversations(list, { contains: 'zzz' })).toEqual([]);
  });

  it('inReplyTo keeps whole threads where a member body cites that envelope id', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a', inReplyTo: 'env-9' }),
      say('c', 'grok', 'zai', 2, { kind: 'status' }),
      say('d', 'zai', 'grok', 3, { kind: 'reply', replyTo: 'c', inReplyTo: 'env-9x' }),
    ], NOW);
    // Only 'b' cites env-9 through its own inReplyTo — 'd' cites a different id
    // and 'a'/'c' cite nothing; whole threads survive, never partial lists.
    expect(filterConversations(list, { inReplyTo: 'env-9' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { inReplyTo: 'env-9' })[0]!.messageCount).toBe(2);
    // Exact and case-sensitive like every bus read: a prefix or case variant never matches.
    expect(filterConversations(list, { inReplyTo: 'env-9x' }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { inReplyTo: 'ENV-9' })).toEqual([]);
    expect(filterConversations(list, { inReplyTo: 'env' })).toEqual([]);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { inReplyTo: 'env-9', state: 'answered' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { inReplyTo: 'env-9', agent: 'grok' })).toEqual([]);
  });

  it('id keeps the whole thread one member message\'s wire id strictly equals', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'grok', 'zai', 2, { kind: 'status' }),
      say('d', 'zai', 'grok', 3, { kind: 'reply', replyTo: 'c' }),
      say('e', 'peer-a', 'peer-b', 4, { kind: 'status', thread: 't-x' }),
      say('f', 'peer-b', 'peer-a', 5, { kind: 'reply', replyTo: 'e', thread: 't-x' }),
    ], NOW);
    // 'b' is a member of thread 'a' — the read returns the whole thread where
    // `phm messages --id b` would report only the one row.
    expect(filterConversations(list, { id: 'b' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { id: 'b' })[0]!.messageCount).toBe(2);
    // The thread root finds the same thread.
    expect(filterConversations(list, { id: 'a' }).map(c => c.id)).toEqual(['a']);
    // A declared bucket is no member id: 't-x' names the conversation, never
    // a wire id — but member 'f' of that bucket still finds it whole.
    expect(filterConversations(list, { id: 't-x' })).toEqual([]);
    expect(filterConversations(list, { id: 'f' }).map(c => c.id)).toEqual(['t-x']);
    // Exact and case-sensitive like every bus read: a case variant or an id
    // nothing carries is an honest empty list, never a widened one.
    expect(filterConversations(list, { id: 'B' })).toEqual([]);
    expect(filterConversations(list, { id: 'env-9' })).toEqual([]);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { id: 'b', state: 'answered' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { id: 'b', agent: 'grok' })).toEqual([]);
  });

  it('channel keeps whole threads where a member message is addressed to the room', () => {
    const list = buildConversations([
      say('a', 'leader', 'group:dev:deploy', 0, { kind: 'ask' }),
      say('b', 'claude', 'group:dev:deploy', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'grok', 'group:ops:alerts', 2, { kind: 'status' }),
      say('d', 'zai', 'leader', 3, { kind: 'status' }),
    ], NOW);
    // 'a'+'b' are one reply chain into the dev room; 'c' sits in ops; 'd' is agent mail.
    expect(filterConversations(list, { channel: 'dev' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { channel: 'ops' }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { channel: 'missing' })).toEqual([]);
    // A topic deeper than one level still sits under the room prefix.
    expect(filterConversations(list, { channel: 'dev:deploy' })).toEqual([]);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { channel: 'dev', agent: 'claude' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { channel: 'dev', agent: 'grok' })).toEqual([]);
  });

  it('priority keeps whole threads where a member message carries that band', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask', priority: 'P0' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a', priority: 'P2' }),
      say('c', 'grok', 'zai', 2, { kind: 'status', priority: 'P1' }),
      say('d', 'zai', 'grok', 3, { kind: 'status' }),
    ], NOW);
    // 'a' is P0 (its reply 'b' is P2 — any member band counts), 'c' is P1, 'd' names no band.
    expect(filterConversations(list, { priority: 'P0' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { priority: 'P1' }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { priority: 'P2' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { priority: 'P3' })).toEqual([]);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { priority: 'P0', state: 'answered' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { priority: 'P0', agent: 'grok' })).toEqual([]);
  });

  it('from keeps threads a sender wrote in and excludeFrom drops them, composing to nothing', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'bot', 'zai', 2, { kind: 'status' }),
      say('d', 'peer-a', 'peer-b', 3, { kind: 'status' }),
      say('e', 'peer-b', 'peer-a', 4, { kind: 'reply', replyTo: 'd' }),
    ], NOW);
    // 'from' decides on the member's sender only — 'a' has leader+claude senders,
    // 'c' is bot-only, 'd'+'e' are the peer pair.
    expect(filterConversations(list, { from: 'leader' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { from: 'bot' }).map(c => c.id)).toEqual(['c']);
    expect(filterConversations(list, { from: 'missing' })).toEqual([]);
    // 'excludeFrom' drops any thread the sender appears in — 'claude' is in 'a',
    // 'bot' only in 'c', 'peer-a' in 'd'.
    expect(filterConversations(list, { excludeFrom: 'claude' }).map(c => c.id).sort()).toEqual(['c', 'd']);
    expect(filterConversations(list, { excludeFrom: 'bot' }).map(c => c.id).sort()).toEqual(['a', 'd']);
    expect(filterConversations(list, { excludeFrom: 'missing' })).toHaveLength(3);
    // A sender both included and excluded matches nothing, like every bus read.
    expect(filterConversations(list, { from: 'leader', excludeFrom: 'leader' })).toEqual([]);
    // The identity resolver folds a sender's labels the same way `agent` does.
    const same = (label: string) => ['leader', 'agt_lead'].includes(label) ? 'agt_lead' : undefined;
    expect(filterConversations(list, { from: 'agt_lead' }, same).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { excludeFrom: 'agt_lead' }, same).map(c => c.id).sort()).toEqual(['c', 'd']);
  });

  it('with keeps threads holding the pairwise exchange agent names, in either direction', () => {
    const list = buildConversations([
      say('a', 'leader', 'claude', 0, { kind: 'ask' }),
      say('b', 'claude', 'leader', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'grok', 'zai', 2, { kind: 'ask' }),
      say('d', 'zai', 'grok', 3, { kind: 'reply', replyTo: 'c' }),
      say('e', 'peer-a', 'peer-b', 4, { kind: 'status' }),
      say('f', 'peer-b', 'peer-c', 5, { kind: 'status' }),
      // 'g'+'h' share thread t-x: leader and claude are both in it, but
      // each only ever addresses grok — never each other.
      say('g', 'leader', 'grok', 6, { kind: 'status', thread: 't-x' }),
      say('h', 'claude', 'grok', 7, { kind: 'status', thread: 't-x' }),
    ], NOW);
    // Threads: 'a' leader<->claude, 'c' grok<->zai, 'e' peer-a->peer-b,
    // 'f' peer-b->peer-c, 't-x' leader+claude via grok — 'd' replies into 'c'.
    expect(filterConversations(list, { agent: 'leader', with: 'claude' }).map(c => c.id)).toEqual(['a']);
    // Either direction counts: agent=claude with=leader finds the same thread.
    expect(filterConversations(list, { agent: 'claude', with: 'leader' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { agent: 'grok', with: 'zai' }).map(c => c.id)).toEqual(['c']);
    // A pair that never exchanges directly never passes: leader and zai
    // share no thread at all, so the pairwise read is an honest empty.
    expect(filterConversations(list, { agent: 'leader', with: 'zai' })).toEqual([]);
    expect(filterConversations(list, { agent: 'peer-a', with: 'peer-b' }).map(c => c.id)).toEqual(['e']);
    expect(filterConversations(list, { agent: 'peer-b', with: 'peer-c' }).map(c => c.id)).toEqual(['f']);
    // with means nothing without agent: an honest empty list, never widened.
    expect(filterConversations(list, { with: 'claude' })).toEqual([]);
    // Both agents in one thread is not the exchange: 't-x' holds leader and
    // claude as participants yet no member runs leader<->claude, so --agent
    // leader alone keeps it while --with claude drops it — 'a' stays.
    expect(filterConversations(list, { agent: 'leader' }).map(c => c.id).sort()).toEqual(['a', 't-x']);
    expect(filterConversations(list, { agent: 'leader', with: 'claude' }).map(c => c.id)).toEqual(['a']);
    // It composes with the other filters like every flag here.
    expect(filterConversations(list, { agent: 'leader', with: 'claude', state: 'answered' }).map(c => c.id)).toEqual(['a']);
    // The identity resolver folds both refs' labels the same way `agent` does.
    const same = (label: string) => ['leader', 'agt_lead'].includes(label) ? 'agt_lead' : undefined;
    expect(filterConversations(list, { agent: 'agt_lead', with: 'claude' }, same).map(c => c.id)).toEqual(['a']);
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

  it('waitingOn keeps waiting threads through the caller predicate, literal label without one', () => {
    const list = buildConversations([say('a', 'leader', 'claude', 0, { kind: 'ask' }), say('b', 'grok', 'zai', 1, { kind: 'status' })], NOW);
    const seen: [string, string][] = [];
    const match = (on: string, from: string) => { seen.push([on, from]); return on === 'claude'; };
    // Only waiting threads invoke the predicate — 'b' is done, so it never asks.
    expect(filterConversations(list, { waitingOn: 'claude' }, undefined, match).map(c => c.id)).toEqual(['a']);
    expect(seen).toEqual([['claude', 'leader']]);
    // Without a predicate the literal waiting.on label matches, case aside.
    expect(filterConversations(list, { waitingOn: 'CLAUDE' }).map(c => c.id)).toEqual(['a']);
    expect(filterConversations(list, { waitingOn: 'agent:claude' })).toEqual([]);
    // The predicate composes with the other filters.
    expect(filterConversations(list, { waitingOn: 'claude', agent: 'grok' }, undefined, match)).toEqual([]);
    expect(filterConversations(list, { waitingOn: 'claude', agent: 'leader' }, undefined, match).map(c => c.id)).toEqual(['a']);
  });

  it('a thread reports every job its messages name and --job keeps whole threads', () => {
    const list = buildConversations([
      say('a', 'peer-a', 'peer-b', 0, { kind: 'ask', thread: 'job:RQ-J1' }),
      say('b', 'peer-b', 'peer-a', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'peer-a', 'peer-c', 2, { kind: 'status', thread: 't-x', jobIds: ['RQ-J2', 'RQ-J1'] }),
      say('d', 'peer-c', 'peer-a', 3, { kind: 'status' }),
    ], NOW);
    // The job:<id> bucket seeds its own id even without per-message jobIds;
    // member citations union in and sort; a thread naming none reports [].
    expect(Object.fromEntries(list.map(c => [c.id, c.jobs]))).toEqual({ 'job:RQ-J1': ['RQ-J1'], 't-x': ['RQ-J1', 'RQ-J2'], d: [] });
    expect(filterConversations(list, { job: 'RQ-J1' }).map(c => c.id).sort()).toEqual(['job:RQ-J1', 't-x']);
    expect(filterConversations(list, { job: 'RQ-J2' }).map(c => c.id)).toEqual(['t-x']);
    expect(filterConversations(list, { job: 'RQ-J3' })).toEqual([]);
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
      subject: 'failed: tier-ceiling', jobs: ['RQ-PEER9'] });
    expect(threads['job:RQ-PEER9']!.messages.map(m => m.id)).toEqual(['p1', 'p2', 'p3']);
    // work.release carries no jobId; the claimKey resolves through the post.
    expect(threads['job:RQ-PEER10']).toMatchObject({ messageCount: 3, state: 'done', jobs: ['RQ-PEER10'] });
    expect(threads['job:RQ-PEER10']!.messages.map(m => m.id)).toEqual(['p4', 'p5', 'p6']);
    expect(result.waiting).toBe(0);
    // Claim tokens never reach the projection.
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  });

  it('a --job read keeps only the whole threads that name the job', () => {
    const root = bus(WORK);
    const nine = readAgentConversations({ job: 'RQ-PEER9' }, { root, now: () => NOW });
    expect(nine.conversations!.map(c => c.id)).toEqual(['job:RQ-PEER9']);
    // The filter drops threads, never messages inside one.
    expect(nine.conversations![0]!.messageCount).toBe(3);
    expect(nine.conversations![0]!.jobs).toEqual(['RQ-PEER9']);
    expect(readAgentConversations({ job: 'RQ-PEER10' }, { root, now: () => NOW }).conversations!.map(c => c.id))
      .toEqual(['job:RQ-PEER10']);
    // A job nothing names is an honest empty list, not an error.
    expect(readAgentConversations({ job: 'RQ-NOPE' }, { root, now: () => NOW }).conversations).toEqual([]);
    // --job composes with --agent and --waiting.
    expect(readAgentConversations({ job: 'RQ-PEER9', agent: 'peer-b' }, { root, now: () => NOW }).conversations!.map(c => c.id))
      .toEqual(['job:RQ-PEER9']);
    expect(readAgentConversations({ job: 'RQ-PEER9', agent: 'peer-c' }, { root, now: () => NOW }).conversations).toEqual([]);
  });

  it('a --blocked read keeps only the threads a failure left unanswered', () => {
    const root = bus(WORK);
    const blocked = readAgentConversations({ blockedOnly: true }, { root, now: () => NOW });
    // RQ-PEER9's failed work.result blocks its thread; RQ-PEER10 completed.
    expect(blocked.conversations!.map(c => c.id)).toEqual(['job:RQ-PEER9']);
    expect(blocked.conversations![0]).toMatchObject({ state: 'blocked', stateText: 'blocked' });
    // `waiting` still counts the whole bus, not the filtered view.
    expect(blocked.waiting).toBe(0);
    // It composes with --job: the done job's intersection is an honest empty.
    expect(readAgentConversations({ blockedOnly: true, job: 'RQ-PEER10' }, { root, now: () => NOW }).conversations).toEqual([]);
    expect(readAgentConversations({ blockedOnly: true, job: 'RQ-PEER9' }, { root, now: () => NOW }).conversations!.map(c => c.id))
      .toEqual(['job:RQ-PEER9']);
  });

  it('a custom-labeled thread reports and filters the job its handoff cites', () => {
    const root = bus([
      // The receivable handoff shape: kind, taskId and prompt only — the bus
      // citation channel, no declared thread, so it roots at its own id.
      [T0, 'w1', 'agent:peer-a', 'agent:peer-b', { kind: 'worker-handoff', taskId: 'RQ-PEER7', prompt: 'Take over' }],
      [T0 + MIN, 'w2', 'agent:peer-b', 'agent:peer-a', { kind: 'note', text: 'on it', replyTo: 'w1' }],
      // A declared custom label carrying a taskId the read-side projection
      // reports as the message's job link.
      [T0 + 2 * MIN, 'h1', 'agent:peer-a', 'agent:peer-b', { kind: 'worker-handoff', taskId: 'RQ-CHAIN9', prompt: 'Take over', thread: 't-chain' }],
      [T0 + 3 * MIN, 'h2', 'agent:peer-b', 'agent:peer-a', { kind: 'note', text: 'ack', replyTo: 'h1' }],
      // A note declaring the job:<id> bucket with no citation at all.
      [T0 + 4 * MIN, 'j1', 'agent:peer-c', 'agent:peer-d', { kind: 'note', text: 'ping', thread: 'job:RQ-BUCKET1' }],
    ]);
    const all = readAgentConversations({}, { root, now: () => NOW });
    const threads = Object.fromEntries(all.conversations!.map(c => [c.id, c]));
    expect(threads['w1']).toMatchObject({ jobs: ['RQ-PEER7'], messageCount: 2 });
    expect(threads['t-chain']).toMatchObject({ jobs: ['RQ-CHAIN9'], messageCount: 2 });
    expect(threads['job:RQ-BUCKET1']).toMatchObject({ jobs: ['RQ-BUCKET1'], messageCount: 1 });
    // Each citation channel alone is enough for the --job read.
    for (const [job, id] of [['RQ-PEER7', 'w1'], ['RQ-CHAIN9', 't-chain'], ['RQ-BUCKET1', 'job:RQ-BUCKET1']] as const) {
      const scoped = readAgentConversations({ job }, { root, now: () => NOW });
      expect(scoped.conversations!.map(c => c.id)).toEqual([id]);
    }
  });

  it('the pure model buckets an explicit thread key over reply chains', () => {
    const list = buildConversations([
      say('a', 'peer-a', 'peer-b', 0, { kind: 'ask', thread: 'job:RQ-X1' }),
      say('b', 'peer-b', 'peer-a', 1, { kind: 'reply', replyTo: 'a' }),
      say('c', 'peer-a', 'peer-b', 2, { kind: 'status', thread: 'job:RQ-X2' }),
    ], NOW);
    expect(list.map(x => [x.id, x.messageCount]).sort()).toEqual([['job:RQ-X1', 2], ['job:RQ-X2', 1]]);
  });

  it('kind keeps the whole threads holding a member of that classified kind', () => {
    const root = bus(WORK);
    const read = (query: Parameters<typeof readAgentConversations>[0]) =>
      readAgentConversations(query, { root, now: () => NOW }).conversations!.map(c => c.id);
    // kind reads each member's classified kind: both job threads hold an
    // ask (their work.post) and a reply (the note's replyTo, the complete
    // result); only RQ-PEER9's failed result classifies a blocker and only
    // RQ-PEER10's work.release reads status.
    expect(read({ kind: 'ask' }).sort()).toEqual(['job:RQ-PEER10', 'job:RQ-PEER9']);
    expect(read({ kind: 'reply' }).sort()).toEqual(['job:RQ-PEER10', 'job:RQ-PEER9']);
    expect(read({ kind: 'blocker' })).toEqual(['job:RQ-PEER9']);
    expect(read({ kind: 'status' })).toEqual(['job:RQ-PEER10']);
    expect(read({ kind: 'handoff' })).toEqual([]);
    // It composes like every other member-level filter: each test keeps
    // whole threads, so a thread passes when any member satisfies each.
    expect(read({ kind: 'blocker', job: 'RQ-PEER10' })).toEqual([]);
    expect(read({ kind: 'reply', job: 'RQ-PEER9' })).toEqual(['job:RQ-PEER9']);
    // The member items carry the classified kind the filter reads.
    const nine = readAgentConversations({ job: 'RQ-PEER9' }, { root, now: () => NOW }).conversations![0]!;
    expect(nine.messages.map(m => m.kind)).toEqual(['ask', 'reply', 'blocker']);
    const ten = readAgentConversations({ job: 'RQ-PEER10' }, { root, now: () => NOW }).conversations![0]!;
    expect(ten.messages.map(m => m.kind)).toEqual(['ask', 'reply', 'status']);
  });

  it('the CLI --job prints only that job\'s threads and refuses a bad id', async () => {
    const root = bus(WORK), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--job', 'RQ-PEER9', '--json'])).toBe(0);
    const printed = JSON.parse(lines.pop()!);
    expect(printed.conversations.map((c: { id: string }) => c.id)).toEqual(['job:RQ-PEER9']);
    expect(await run(['--job', 'has space'])).toBe(2);
    expect(errors.pop()).toContain('--job takes a job id');
  });

  it('the CLI --kind filters threads and refuses a bad value', async () => {
    const root = bus(WORK), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--kind', 'blocker', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['job:RQ-PEER9']);
    expect(await run(['--kind', 'bogus'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('--waiting-on', () => {
  // a1 waits on claude inside a job thread; a5/a6 wait on the eng channel —
  // a6 was sent by claude itself, so claude never owes it; a7 is already
  // answered; a4 is done.
  const WAIT_ON: [number, string, string, string, Record<string, unknown>][] = [
    [T0, 'a1', 'leader', 'agent:claude', { kind: 'note', text: 'can you review?', thread: 'job:RQ-J1' }],
    [T0 + MIN, 'a2', 'agent:grok', 'agent:zai', { kind: 'note', text: 'status?' }],
    [T0 + 2 * MIN, 'a3', 'agent:claude', 'leader', { kind: 'note', text: 'question for you?' }],
    [T0 + 3 * MIN, 'a4', 'leader', 'agent:claude', { kind: 'note', text: 'fyi only' }],
    [T0 + 4 * MIN, 'a5', 'agent:peer', 'group:eng:general', { kind: 'note', text: 'deploy window?' }],
    [T0 + 5 * MIN, 'a6', 'agent:claude', 'group:eng:general', { kind: 'note', text: 'claude asks the room?' }],
    [T0 + 6 * MIN, 'a7', 'leader', 'agent:claude', { kind: 'note', text: 'one more?' }],
    [T0 + 7 * MIN, 'a8', 'agent:claude', 'leader', { kind: 'note', text: 'answer', replyTo: 'a7' }],
  ];
  function registered() {
    const root = bus(WAIT_ON);
    expect(registerAgentIdentity({ handle: 'claude', aliases: ['claude-7'] }, { root }).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'atlas' }, { root }).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'zai' }, { root }).status).toBe('created');
    expect(createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['claude'] }, { root }).status).toBe('created');
    return root;
  }
  const owed = (root: string, waitingOn: string) =>
    readAgentConversations({ waitingOn }, { root, now: () => NOW }).conversations!.map(c => c.id);

  it('keeps the waiting threads one agent owes a reply on, under any of its labels', () => {
    const root = registered();
    // The direct ask and the channel ask claude did not send; its own channel
    // ask (a6) never counts — you cannot owe yourself a reply.
    for (const ref of ['claude', 'claude-7', 'agent:claude']) expect(owed(root, ref)).toEqual(['job:RQ-J1', 'a5']);
    // atlas is an eng member that sent neither channel ask.
    expect(owed(root, 'atlas')).toEqual(['a5', 'a6']);
    expect(owed(root, 'zai')).toEqual(['a2']);
    // An unregistered ref keeps the literal-label match.
    expect(owed(root, 'leader')).toEqual(['a3']);
    expect(owed(root, 'nobody')).toEqual([]);
  });

  it('without a registry the match stays on the literal waiting.on label', () => {
    const root = bus(WAIT_ON);
    // No channel knowledge: only the bare-label waits denote claude.
    expect(owed(root, 'claude')).toEqual(['job:RQ-J1']);
    expect(owed(root, 'agent:claude')).toEqual(['job:RQ-J1']);
    expect(owed(root, 'group:eng:general')).toEqual(['a5', 'a6']);
  });

  it('composes with --agent and --job', () => {
    const root = registered();
    const read = (query: Parameters<typeof readAgentConversations>[0]) =>
      readAgentConversations(query, { root, now: () => NOW }).conversations!.map(c => c.id);
    expect(read({ waitingOn: 'claude', agent: 'leader' })).toEqual(['job:RQ-J1']);
    expect(read({ waitingOn: 'claude', agent: 'peer' })).toEqual(['a5']);
    expect(read({ waitingOn: 'claude', job: 'RQ-J1' })).toEqual(['job:RQ-J1']);
    expect(read({ waitingOn: 'claude', job: 'RQ-J2' })).toEqual([]);
    expect(read({ waitingOn: 'claude', waitingOnly: true })).toEqual(['job:RQ-J1', 'a5']);
  });

  it('the CLI --waiting-on prints that JSON and refuses a missing value', async () => {
    const root = registered(), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--waiting-on', 'claude', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['job:RQ-J1', 'a5']);
    expect(await run(['--waiting-on'])).toBe(2);
    expect(await run(['--waiting-on', '--json'])).toBe(2);
    expect(errors.pop()).toContain('Usage: phm agents conversations');
  });
});

describe('phm agents conversations --json', () => {
  it('has a stable shape and reads the bus', () => {
    const result = readAgentConversations({}, { root: bus(CHAT), now: () => NOW });
    expect(Object.keys(result)).toEqual(['schema', 'version', 'generatedAt', 'source', 'conversations', 'matched', 'waiting', 'skipped']);
    expect(result).toMatchObject({ schema: 'agents.conversations.v1', version: 1, source: 'available', matched: 2, waiting: 1, skipped: 0 });
    expect(Object.keys(result.conversations![0]!)).toEqual(['id', 'participants', 'subject', 'messageCount', 'lastAt', 'state', 'stateText', 'waiting', 'jobs', 'links', 'messages']);
    expect(result.conversations!.map(c => [c.id, c.state])).toEqual([['m3', 'waiting'], ['m1', 'answered']]);
    // Every member item carries its envelope band; a body `inReplyTo` citation
    // joins only the messages that make one, appended after `subject`.
    expect(Object.keys(result.conversations![0]!.messages[0]!)).toEqual(['id', 'at', 'from', 'to', 'kind', 'subject', 'priority']);
  });

  it('matched reports the filtered total while limit caps the page', () => {
    const root = bus(CHAT);
    const all = readAgentConversations({}, { root, now: () => NOW });
    expect(all.matched).toBe(2);
    expect(all.conversations).toHaveLength(2);
    const capped = readAgentConversations({ limit: 1 }, { root, now: () => NOW });
    // Longest-waiting first is the kept order: the waiting thread shows.
    expect(capped.conversations!.map(c => c.id)).toEqual(['m3']);
    expect(capped.matched).toBe(2);
    // The filter and the cap compose: --state narrows, then limit cuts.
    const answered = readAgentConversations({ state: 'answered', limit: 5 }, { root, now: () => NOW });
    expect(answered.matched).toBe(1);
    expect(answered.conversations!.map(c => c.id)).toEqual(['m1']);
    // An empty filtered page still reports matched 0, never null.
    expect(readAgentConversations({ state: 'blocked' }, { root, now: () => NOW })).toMatchObject({ matched: 0, conversations: [] });
    const text = formatAgentConversationsText(capped);
    expect(text).toContain('1 of 2 conversations');
    expect(formatAgentConversationsText(all)).toContain('2 conversations');
  });

  it('a since read keeps only threads active since the cutoff', () => {
    const root = bus(CHAT);
    // m1's thread last spoke at T0+1m, m3's wait at T0+2m; NOW is T0+30m.
    const recent = readAgentConversations({ since: T0 + 90_000 }, { root, now: () => NOW });
    expect(recent.conversations!.map(c => c.id)).toEqual(['m3']);
    expect(recent.matched).toBe(1);
    // `waiting` still counts the whole bus, filtered or not.
    expect(recent.waiting).toBe(1);
    // A cutoff past both threads is an honest empty page, not an error.
    expect(readAgentConversations({ since: T0 + 3 * MIN }, { root, now: () => NOW }))
      .toMatchObject({ matched: 0, conversations: [] });
    // It composes with --state: m3 waits, so the answered-only page is empty.
    expect(readAgentConversations({ since: T0 + 90_000, state: 'answered' }, { root, now: () => NOW }).conversations).toEqual([]);
  });

  it('a before read keeps only threads last active before the cutoff', () => {
    const root = bus(CHAT);
    // m1's thread last spoke at T0+1m, m3's wait at T0+2m.
    const older = readAgentConversations({ before: T0 + 90_000 }, { root, now: () => NOW });
    expect(older.conversations!.map(c => c.id)).toEqual(['m1']);
    expect(older.matched).toBe(1);
    // `waiting` still counts the whole bus, filtered or not.
    expect(older.waiting).toBe(1);
    // Exclusive: m3's wait landed exactly on this cutoff, so it drops while
    // m1's older thread stays; a cutoff on m1's own last activity empties all.
    expect(readAgentConversations({ before: T0 + 2 * MIN }, { root, now: () => NOW }).conversations!.map(c => c.id)).toEqual(['m1']);
    expect(readAgentConversations({ before: T0 + MIN }, { root, now: () => NOW }).conversations).toEqual([]);
    // since/before read one [since, before) window on lastAt.
    const windowed = readAgentConversations({ since: T0, before: T0 + 90_000 }, { root, now: () => NOW });
    expect(windowed.conversations!.map(c => c.id)).toEqual(['m1']);
    expect(windowed.matched).toBe(1);
    // An inverted window is an honest empty page, not an error.
    expect(readAgentConversations({ since: T0 + 3 * MIN, before: T0 + MIN }, { root, now: () => NOW }))
      .toMatchObject({ matched: 0, conversations: [] });
  });

  it('an empty bus is source missing with no conversations', () => {
    expect(readAgentConversations({}, { root: bus(), now: () => NOW })).toEqual({ schema: 'agents.conversations.v1', version: 1,
      generatedAt: '2026-11-18T12:30:00.000Z', source: 'missing', conversations: [], matched: 0, waiting: 0, skipped: 0 });
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
    // A case-variant of the handle or alias resolves to no identity: it keeps
    // the literal participant-name match, never the identity's other labels.
    expect(readAgentConversations({ agent: 'Atlas' }, { root, now: () => NOW }).conversations!.map(c => c.id)).toEqual(['m1']);
    expect(readAgentConversations({ agent: 'DEVIN-CLOUD' }, { root, now: () => NOW }).conversations!.map(c => c.id)).toEqual(['m3']);
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

  it('a dead-letter notice is a delivery report: it forms no thread and never answers a wait', () => {
    const deadLetter = (id: string, correlation: string) => ({ protocol: { version: 1, kind: 'status' }, correlation_id: correlation,
      payload: { deadLetter: { id: 'lost-' + id, from: 'a', to: 'b', kind: 'note', reason: 'exhausted', deadLetteredAt: 1, attempts: [] },
        payloadDropped: false, envelope: null } });
    const root = bus([
      [T0, 'a1', 'agent:nova', 'agent:atlas', { kind: 'note', text: 'deploy window?' }],
      [T0 + MIN, 'd1', 'bus-router', 'bus.dead-letter', deadLetter('d1', 'c-1')],
      [T0 + 2 * MIN, 'd2', 'bus-router', 'bus.dead-letter', deadLetter('d2', 'c-2')],
    ]);
    const result = readAgentConversations({}, { root, now: () => NOW });
    // Only the note is mail: both notices are excluded, so it still waits.
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations![0]).toMatchObject({ id: 'a1', state: 'waiting', messageCount: 1,
      waiting: { on: 'atlas' } });
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

  it('inReplyTo, channel, priority and from read the same member fields every bus read filters on', () => {
    const root = bus([
      [T0, 'r1', 'leader', 'claude', { text: 'can you look?' }],
      [T0 + MIN, 'r2', 'claude', 'leader', { text: 'yes', inReplyTo: 'r1' }, { priority: 'P0' }],
      [T0 + 2 * MIN, 'r3', 'bot', 'group:dev:deploy', { kind: 'note', text: 'room note' }],
      [T0 + 3 * MIN, 'r4', 'grok', 'zai', { text: 'unrelated' }],
    ]);
    const read = (query: Parameters<typeof readAgentConversations>[0]) =>
      readAgentConversations(query, { root, now: () => NOW }).conversations!.map(c => c.id);
    // r1+r2 cite through the body's own inReplyTo; r2's P0 band and r3's room address mark their threads.
    expect(read({ inReplyTo: 'r1' })).toEqual(['r1']);
    expect(read({ inReplyTo: 'r2' })).toEqual([]);
    expect(read({ channel: 'dev' })).toEqual(['r3']);
    expect(read({ priority: 'P0' })).toEqual(['r1']);
    // r1, r3 and r4 all carry the default P2 band; only r2 is P0.
    expect(read({ priority: 'P2' }).sort()).toEqual(['r1', 'r3', 'r4']);
    expect(read({ from: 'bot' })).toEqual(['r3']);
    expect(read({ excludeFrom: 'bot' }).sort()).toEqual(['r1', 'r4']);
    // They compose like every other filter and stay whole-thread reads.
    expect(read({ channel: 'dev', priority: 'P0' })).toEqual([]);
    expect(read({ inReplyTo: 'r1', from: 'claude' })).toEqual(['r1']);
    expect(read({ inReplyTo: 'r1', from: 'grok' })).toEqual([]);
  });

  it('thread keeps the declared bucket and bodyKind the member discriminator, whole threads', () => {
    const root = bus([
      [T0, 't1', 'leader', 'claude', { kind: 'note', text: 'ship it?', thread: 'release-1' }],
      [T0 + MIN, 't2', 'claude', 'leader', { kind: 'note', text: 'on it', replyTo: 't1' }],
      [T0 + 2 * MIN, 't3', 'grok', 'zai', { text: 'unrelated ping' }],
      [T0 + 3 * MIN, 't4', 'peer-a', 'peer-b', { kind: 'work.post', jobId: 'RQ-T1', title: 'Fix', repo: 'a/b', claimKeys: ['repo:a/b'] }],
    ]);
    const read = (query: Parameters<typeof readAgentConversations>[0]) =>
      readAgentConversations(query, { root, now: () => NOW }).conversations!.map(c => c.id);
    // t1 declares release-1 and t2 inherits the bucket through replyTo: one thread.
    expect(read({ thread: 'release-1' })).toEqual(['release-1']);
    // The match is exact, never a substring or a reply-chain root.
    expect(read({ thread: 'release' })).toEqual([]);
    expect(read({ thread: 't1' })).toEqual([]);
    // A job:<id> bucket is a declared key too; an undeclared chain's root
    // envelope id stays --id's match, never --thread's.
    expect(read({ thread: 'job:RQ-T1' })).toEqual(['job:RQ-T1']);
    expect(read({ thread: 't3' })).toEqual([]);
    expect(read({ id: 't3' })).toEqual(['t3']);
    // bodyKind reads each member's own discriminator: t1/t2 are notes,
    // t4 is a work.post, t3's kindless body names no provable kind.
    expect(read({ bodyKind: 'note' })).toEqual(['release-1']);
    expect(read({ bodyKind: 'work.post' })).toEqual(['job:RQ-T1']);
    expect(read({ bodyKind: 'context' })).toEqual([]);
    // They compose like every other member-level filter.
    expect(read({ thread: 'release-1', bodyKind: 'note' })).toEqual(['release-1']);
    expect(read({ thread: 'release-1', bodyKind: 'work.post' })).toEqual([]);
    expect(read({ bodyKind: 'note', from: 'leader' })).toEqual(['release-1']);
    expect(read({ bodyKind: 'note', from: 'grok' })).toEqual([]);
    // The member items carry the fields the filters read, verbatim.
    const thread = readAgentConversations({ thread: 'release-1' }, { root, now: () => NOW }).conversations![0]!;
    expect(thread.messages.map(m => m.thread)).toEqual(['release-1', 'release-1']);
    expect(thread.messages.map(m => m.bodyKind)).toEqual(['note', 'note']);
  });

  it('the CLI --thread and --body-kind filter and refuse bad values', async () => {
    const root = bus([
      [T0, 't1', 'leader', 'claude', { kind: 'note', text: 'ship it?', thread: 'release-1' }],
      [T0 + MIN, 't2', 'claude', 'leader', { kind: 'note', text: 'on it', replyTo: 't1' }],
      [T0 + 2 * MIN, 't3', 'grok', 'zai', { kind: 'work.status', jobId: 'RQ-T2', status: 'running', text: 'working' }],
    ]);
    const lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--thread', 'release-1', '--json'])).toBe(0);
    const byThread = JSON.parse(lines.pop()!);
    expect(byThread.conversations.map((c: { id: string }) => c.id)).toEqual(['release-1']);
    expect(byThread.matched).toBe(1);
    expect(await run(['--body-kind', 'work.status', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['job:RQ-T2']);
    expect(await run(['--thread'])).toBe(2);
    expect(await run(['--body-kind', '--json'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
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

  it('the CLI --blocked prints only the threads a blocker or failure left', async () => {
    const root = bus([
      [T0, 'b1', 'claude', 'leader', { kind: 'blocker', text: 'need access' }],
      [T0 + MIN, 'b2', 'leader', 'claude', { kind: 'note', text: 'fyi only' }],
      [T0 + 2 * MIN, 'b3', 'grok', 'zai', { kind: 'status', status: 'blocked', text: 'quota out' }],
    ]);
    const lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--blocked', '--json'])).toBe(0);
    const printed = JSON.parse(lines.pop()!);
    expect(printed.conversations.map((c: { id: string }) => c.id).sort()).toEqual(['b1', 'b3']);
    expect(printed.conversations.every((c: { state: string }) => c.state === 'blocked')).toBe(true);
    // Text mode names the state too, and --blocked composes with --agent.
    expect(await run(['--blocked', '--agent', 'grok'])).toBe(0);
    const text = lines.pop()!;
    expect(text).toContain('blocked');
    expect(text).toContain('zai');
    expect(text).not.toContain('need access');
  });

  it('the CLI --state and --limit filter and cap, matched stays the total', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    expect(await run(['--state', 'answered', '--json'])).toBe(0);
    const answered = JSON.parse(lines.pop()!);
    expect(answered.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(answered.matched).toBe(1);
    expect(await run(['--state', 'done', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    expect(await run(['--limit', '1', '--json'])).toBe(0);
    const capped = JSON.parse(lines.pop()!);
    expect(capped.conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    expect(capped.matched).toBe(2);
    // Text mode names the truncated page honestly.
    expect(await run(['--limit', '1'])).toBe(0);
    expect(lines.pop()).toContain('1 of 2 conversations');
    // Bad values are usage errors, never a silent default.
    expect(await run(['--state', 'open'])).toBe(2);
    expect(await run(['--state'])).toBe(2);
    expect(await run(['--limit', '0'])).toBe(2);
    expect(await run(['--limit', '2000'])).toBe(2);
    expect(await run(['--limit'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it('the CLI --since filters by last activity and refuses a bad cutoff', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    // 25m before NOW (T0+30m) is T0+5m — both threads went quiet before it.
    expect(await run(['--since', '25m', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    // 28m before NOW is exactly T0+2m — m3's wait landed on the cutoff.
    expect(await run(['--since', '28m', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // An ISO cutoff between the two last-activity times splits them the same way.
    expect(await run(['--since', '2026-11-18T12:01:30.000Z', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // --since composes with the other filters like every flag here.
    expect(await run(['--since', '28m', '--waiting', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // Bad values are usage errors, never a silent default.
    expect(await run(['--since', 'bogus'])).toBe(2);
    expect(await run(['--since'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('the CLI --before filters by last activity and refuses a bad cutoff', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    // 29m before NOW (T0+30m) is T0+1m — exactly m1's last activity, exclusive.
    expect(await run(['--before', '29m', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    // 28.5m before NOW is T0+1.5m — m1's thread stayed, m3's newer wait did not.
    expect(await run(['--before', '1710s', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    // An ISO cutoff past both threads lists them all, m3 first (waiting pins).
    expect(await run(['--before', '2026-11-18T12:30:00.000Z', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3', 'm1']);
    // --before composes with --since into one window and the other filters:
    // [T0+1m, T0+2m) keeps m1 — exactly on the since bound — and drops m3.
    expect(await run(['--since', '29m', '--before', '28m', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(await run(['--before', '27m', '--waiting', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // An inverted window is an honest empty page, not an error.
    expect(await run(['--since', '28m', '--before', '29m', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    // Bad values are usage errors, never a silent default.
    expect(await run(['--before', 'bogus'])).toBe(2);
    expect(await run(['--before'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('the CLI --contains filters by subject text and refuses a bad needle', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    // 'build' is only in the answered thread's subjects; 'docs' only in the wait.
    expect(await run(['--contains', 'BUILD', '--json'])).toBe(0);
    const hit = JSON.parse(lines.pop()!);
    expect(hit.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(hit.matched).toBe(1);
    expect(await run(['--contains', 'docs', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // No match is an honest empty page, matched 0, never an error.
    expect(await run(['--contains', 'zzz', '--json'])).toBe(0);
    const none = JSON.parse(lines.pop()!);
    expect(none.conversations).toEqual([]);
    expect(none.matched).toBe(0);
    // It composes with the other filters like every flag here.
    expect(await run(['--contains', 'build', '--waiting', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    // Bad values are usage errors, never a silent default.
    expect(await run(['--contains'])).toBe(2);
    expect(await run(['--contains', '   '])).toBe(2);
    expect(await run(['--contains', 'x'.repeat(513)])).toBe(2);
    expect(await run(['--contains', '--json'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it('the CLI --with narrows --agent to the pairwise exchange and needs --agent', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    // CHAT: m1 leader<->claude answered, m3 grok->zai waiting.
    expect(await run(['--agent', 'leader', '--with', 'claude', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(await run(['--agent', 'claude', '--with', 'leader', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    // A pair that never exchanges is an honest empty page.
    expect(await run(['--agent', 'leader', '--with', 'zai', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    // --with without --agent is a usage error, never a widened read.
    expect(await run(['--with', 'claude'])).toBe(2);
    expect(errors.pop()).toContain('--with takes the other agent and needs --agent');
    expect(await run(['--with'])).toBe(2);
    expect(await run(['--agent', 'leader', '--with', 'has space'])).toBe(2);
  });

  it('the CLI --id keeps the thread the envelope belongs to and refuses a bad id', async () => {
    const root = bus(CHAT), lines: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runAgentsConversationsCli(args, text => lines.push(text), text => errors.push(text), { root, now: () => NOW });
    // CHAT: m1 leader->claude, m2 claude->leader replyTo m1 (thread m1), m3 grok->zai (thread m3).
    // m2 is a member of thread m1 — the read returns the whole thread where
    // `phm messages --id m2` would report only the one row.
    expect(await run(['--id', 'm2', '--json'])).toBe(0);
    const hit = JSON.parse(lines.pop()!);
    expect(hit.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(hit.conversations[0].messageCount).toBe(2);
    expect(hit.matched).toBe(1);
    expect(await run(['--id', 'm3', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // An id nothing on the bus carries is an honest empty page, matched 0.
    expect(await run(['--id', 'env-9', '--json'])).toBe(0);
    const none = JSON.parse(lines.pop()!);
    expect(none.conversations).toEqual([]);
    expect(none.matched).toBe(0);
    // It composes with the other filters like every flag here.
    expect(await run(['--id', 'm2', '--agent', 'grok', '--json'])).toBe(0);
    expect(JSON.parse(lines.pop()!).conversations).toEqual([]);
    // Bad values are usage errors, never a silent default.
    expect(await run(['--id', 'has space'])).toBe(2);
    expect(await run(['--id'])).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('the API serves the same read behind a read session and checks its query', async () => {
    const root = bus(CHAT);
    const serve = (module: ReturnType<typeof createFleetLiveMapApi>) =>
      async (url: string, readSession: unknown = { expiresAt: Date.now() + 60_000 }) => {
        let status = 0, body = '';
        const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (text?: string) => { body = text ?? ''; }, statusCode: 0 };
        await module({ readSession } as never, { url, headers: {} } as never, res as never, AGENT_CONVERSATIONS_PATH, 'GET');
        return { status: status || res.statusCode, body: body ? JSON.parse(body) : null };
      };
    const call = serve(createFleetLiveMapApi(undefined, undefined, undefined,
      query => readAgentConversations(query, { root, now: () => NOW })));
    const ok = await call(`${AGENT_CONVERSATIONS_PATH}?waiting=1`);
    expect(ok.status).toBe(200);
    expect(ok.body.conversations).toHaveLength(1);
    const scoped = await call(`${AGENT_CONVERSATIONS_PATH}?job=RQ-1`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.conversations).toEqual([]);
    const owed = await call(`${AGENT_CONVERSATIONS_PATH}?waitingOn=zai`);
    expect(owed.status).toBe(200);
    expect(owed.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    // state and limit narrow and cap the same read, matched stays the total.
    const answered = await call(`${AGENT_CONVERSATIONS_PATH}?state=answered`);
    expect(answered.status).toBe(200);
    expect(answered.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(answered.body.matched).toBe(1);
    const capped = await call(`${AGENT_CONVERSATIONS_PATH}?limit=1`);
    expect(capped.status).toBe(200);
    expect(capped.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    expect(capped.body.matched).toBe(2);
    // since keeps threads active inside the window; bad values are refused.
    const recent = await call(`${AGENT_CONVERSATIONS_PATH}?since=${T0 + 90_000}`);
    expect(recent.status).toBe(200);
    expect(recent.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m3']);
    expect(recent.body.matched).toBe(1);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?since=bogus`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?since=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?since=1&since=2`)).status).toBe(400);
    // before keeps threads last active strictly before the cutoff, composing
    // with since into one [since, before) window; bad values are refused.
    const older = await call(`${AGENT_CONVERSATIONS_PATH}?before=${T0 + 90_000}`);
    expect(older.status).toBe(200);
    expect(older.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(older.body.matched).toBe(1);
    const windowed = await call(`${AGENT_CONVERSATIONS_PATH}?since=${T0}&before=${T0 + 90_000}`);
    expect(windowed.status).toBe(200);
    expect(windowed.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?before=bogus`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?before=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?before=1&before=2`)).status).toBe(400);
    // contains keeps threads whose member subjects carry the needle — the same
    // text search --contains applies — and bad needles are refused.
    const found = await call(`${AGENT_CONVERSATIONS_PATH}?contains=BUILD`);
    expect(found.status).toBe(200);
    expect(found.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(found.body.matched).toBe(1);
    // with narrows agent to the pairwise exchange; it needs agent and a bad value is refused.
    const pair = await call(`${AGENT_CONVERSATIONS_PATH}?agent=leader&with=claude`);
    expect(pair.status).toBe(200);
    expect(pair.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    const none = await call(`${AGENT_CONVERSATIONS_PATH}?agent=leader&with=zai`);
    expect(none.status).toBe(200);
    expect(none.body.conversations).toEqual([]);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?with=claude`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?agent=leader&with=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?agent=leader&with=a&with=b`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?agent=leader&with=has%20space`)).status).toBe(400);
    // id keeps the thread the named envelope belongs to; bad values are refused.
    const member = await call(`${AGENT_CONVERSATIONS_PATH}?id=m2`);
    expect(member.status).toBe(200);
    expect(member.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect(member.body.matched).toBe(1);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?id=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?id=a&id=b`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?id=has%20space`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?contains=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?contains=%20%20`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?contains=a&contains=b`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?contains=${'x'.repeat(513)}`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?state=open`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?state=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?limit=0`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?limit=2000`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?limit=a`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?waitingOn=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?waitingOn=a&waitingOn=b`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?job=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?job=a&job=b`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?blocked=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?blocked=2`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?blocked=1&blocked=0`)).status).toBe(400);
    // kind keeps threads holding a member of that classified kind; bad
    // values are refused.
    const replyKind = await call(`${AGENT_CONVERSATIONS_PATH}?kind=reply`);
    expect(replyKind.status).toBe(200);
    expect(replyKind.body.conversations.map((c: { id: string }) => c.id)).toEqual(['m1']);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?kind=bogus`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?kind=`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?kind=a&kind=b`)).status).toBe(400);
    expect((await call(`${AGENT_CONVERSATIONS_PATH}?extra=1`)).status).toBe(400);
    expect((await call(AGENT_CONVERSATIONS_PATH, null)).status).toBe(401);
    // blocked=1 keeps only the blocked threads, same as --blocked.
    const blockedRoot = bus([
      [T0, 'b1', 'claude', 'leader', { kind: 'blocker', text: 'need access' }],
      [T0 + MIN, 'b2', 'leader', 'claude', { kind: 'note', text: 'fyi only' }],
    ]);
    const blockedCall = serve(createFleetLiveMapApi(undefined, undefined, undefined,
      query => readAgentConversations(query, { root: blockedRoot, now: () => NOW })));
    const only = await blockedCall(`${AGENT_CONVERSATIONS_PATH}?blocked=1`);
    expect(only.status).toBe(200);
    expect(only.body.conversations.map((c: { id: string }) => c.id)).toEqual(['b1']);
    const all = await blockedCall(AGENT_CONVERSATIONS_PATH);
    expect(all.body.conversations).toHaveLength(2);
  });
});
