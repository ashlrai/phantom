import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity, createAgentChannel, stableAgentId, leaveAgentChannel } from '../src/core/agents/bus-identity.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { readAgentChat } from '../src/core/agents/chat.js';
import { runAgentsChat } from '../src/cli/agents-chat.js';
import { agentChatResponse } from '../src/core/web/agent-chat-route.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chat-')); dirs.push(dir);
  const options = { root: join(dir, 'fleet'), now: () => 1000 };
  for (const handle of ['alice', 'bob', 'outsider']) expect(registerAgentIdentity({ handle,
    runtime: { cli: 'codex', provider: 'codex-personal', model: 'test-model' } }, options).status).toBe('created');
  expect(createAgentChannel({ name: 'engineering', createdBy: 'alice', members: ['bob'] }, options).status).toBe('created');
  return options;
}
function envelope(id: string, extra: Partial<BusEnvelope> = {}): BusEnvelope {
  return { id, from: 'agent:alice', to: 'group:engineering:general', priority: 'P2', ttl: 10000,
    channel: 'bus', channel_ref: 'group:engineering:general', external: false, origin_bridge: 'agent-bus',
    sender: { agent_id: stableAgentId('alice'), vendor: 'codex-personal', human: false, team: true },
    body: { kind: 'note', thread: 'run:one', text: 'hello' }, ...extra };
}
function add(options: ReturnType<typeof setup>, e: BusEnvelope) {
  expect(appendBusInbox(e, options).status).toBe('posted');
}
describe('agent chat', () => {
  it('lists retained outcome/run threads with deterministic roster and honest unknown presence', () => {
    const options = setup(); add(options, envelope('a'));
    add(options, envelope('b', { body: { kind: 'context', thread: 'outcome:two', text: 'context' } }));
    const result = readAgentChat({ channel: 'engineering' }, options);
    expect(result.status).toBe('ok'); if (result.status !== 'ok') return;
    expect(result.threads.map(t => t.id)).toEqual(['outcome:two', 'run:one']);
    expect(result.messages).toEqual([]); expect(result.participants).toHaveLength(2);
    expect(result.participants[0]).toMatchObject({ engine: 'test-model', state: 'unknown' });
    expect(result.participants[0]!.avatarColor).toMatch(/^#[a-f0-9]{6}$/);
    expect(readAgentChat({ channel: 'engineering' }, options)).toEqual(result);
  });
  it('orders by receipt cursor rather than priority; pages without omission', () => {
    const options = setup(); add(options, envelope('a', { priority: 'P3' }));
    add(options, envelope('b', { priority: 'P0' }));
    const first = readAgentChat({ channel: 'engineering', thread: 'run:one', limit: 1 }, options);
    expect(first.status).toBe('ok'); if (first.status !== 'ok') return;
    expect(first.messages[0]!.id).toBe('a'); expect(first.hasMore).toBe(true);
    const next = readAgentChat({ channel: 'engineering', thread: 'run:one', after: first.nextCursor }, options);
    expect(next.status === 'ok' && next.messages.map(m => m.id)).toEqual(['b']);
  });
  it('crosses store page boundaries and does not lose matches after 100 unrelated rows', () => {
    const options = setup();
    for (let i = 0; i < 101; i++) add(options, envelope(`noise-${i}`, { to: 'agent:bob' }));
    add(options, envelope('last'));
    const result = readAgentChat({ channel: 'engineering', thread: 'run:one' }, options);
    expect(result.status === 'ok' && result.messages.map(m => m.id)).toEqual(['last']);
  });
  it.each([
    { channel: 'imessage' }, { external: true }, { origin_bridge: 'other' },
    { to: 'agent:bob' }, { to: 'group:other:general' }, { channel_ref: 'group:other:general' },
    { from: 'agent:outsider' }, { sender: { agent_id: 'fake', vendor: 'local', human: true, team: true } },
    { body: { kind: 'note', text: 'unscoped' } },
  ] as Partial<BusEnvelope>[])('withholds private/unscoped/mismatched envelope %j', extra => {
    const options = setup(); add(options, envelope('private', extra));
    const result = readAgentChat({ channel: 'engineering', thread: 'run:one' }, options);
    expect(result.status === 'ok' && result.messages).toEqual([]);
  });
  it('does not promote a human flag into an owner interjection', () => {
    const options = setup(); const e = envelope('human'); e.sender!.human = true; add(options, e);
    const result = readAgentChat({ channel: 'engineering', thread: 'run:one' }, options);
    expect(result.status === 'ok' && result.messages[0]!.kind).toBe('message');
  });
  it('excludes expired rows and removed members', () => {
    const options = setup(); add(options, envelope('a'));
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one' }, { ...options, now: () => 11001 }))
      .toMatchObject({ status: 'ok', messages: [] });
    leaveAgentChannel('engineering', 'alice', options);
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one' }, options)).toMatchObject({ messages: [] });
  });
  it.each([{ channel: '../bad' }, { channel: 'engineering', thread: 'other' },
    { channel: 'engineering', limit: 101 }, { channel: 'engineering', after: -1 }])('rejects malformed query', query => {
    expect(readAgentChat(query, setup()).status).toBe('invalid');
  });
  it('refuses future cursors rather than skipping subsequently arriving messages', () => {
    const options = setup(); add(options, envelope('a'));
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one', after: 2 }, options)).toEqual({ status: 'invalid' });
  });
  it('CLI and HTTP preserve the explicit scope and reject extra/repeated arguments', () => {
    const options = setup(); const read = (q: Parameters<typeof readAgentChat>[0]) => readAgentChat(q, options);
    const output: string[] = [];
    expect(runAgentsChat(['read', 'run:one', '--channel', 'engineering', '--json'], s => output.push(s), () => {}, read)).toBe(0);
    expect(JSON.parse(output[0]!).channel).toBe('engineering');
    expect(runAgentsChat(['list', '--channel', 'engineering', '--json', '--json'], () => {}, () => {}, read)).toBe(2);
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&thread=run:one', read).code).toBe(200);
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&channel=other', read).code).toBe(400);
    expect(agentChatResponse('GET', '/api/agents/chat?root=/tmp', read).code).toBe(400);
    expect(agentChatResponse('POST', '/api/agents/chat', read).code).toBe(405);
  });
  it('filters messages and the thread index by sender through the shared from/exclude-from rule', () => {
    const options = setup();
    const bob = { from: 'agent:bob',
      sender: { agent_id: stableAgentId('bob'), vendor: 'codex-personal', human: false, team: true } };
    add(options, envelope('a1', { body: { kind: 'note', thread: 'run:one', text: 'alpha' } }));
    add(options, envelope('b1', { ...bob, body: { kind: 'note', thread: 'run:two', text: 'beta' } }));
    add(options, envelope('a2', { body: { kind: 'note', thread: 'run:two', text: 'gamma' } }));
    const from = readAgentChat({ channel: 'engineering', thread: 'run:two', from: 'bob' }, options);
    expect(from.status === 'ok' && from.messages.map(m => m.id)).toEqual(['b1']);
    const address = readAgentChat({ channel: 'engineering', thread: 'run:two', from: 'agent:bob' }, options);
    expect(address.status === 'ok' && address.messages.map(m => m.id)).toEqual(['b1']);
    const excluded = readAgentChat({ channel: 'engineering', thread: 'run:two', excludeFrom: 'bob' }, options);
    expect(excluded.status === 'ok' && excluded.messages.map(m => m.id)).toEqual(['a2']);
    const list = readAgentChat({ channel: 'engineering', from: 'bob' }, options);
    expect(list.status === 'ok'); if (list.status !== 'ok') return;
    expect(list.threads.map(t => t.id)).toEqual(['run:two']);
    expect(list.threads[0]).toMatchObject({ messageCount: 1 });
    expect(list.messages).toEqual([]);
  });
  it('matches contains over the same scrubbed summary the row renders', () => {
    const options = setup();
    add(options, envelope('a', { body: { kind: 'note', thread: 'run:one', text: 'Deploy   the\nfix' } }));
    add(options, envelope('b', { body: { kind: 'note', thread: 'run:one', text: 'standup notes' } }));
    const hit = readAgentChat({ channel: 'engineering', thread: 'run:one', contains: '  DEPLOY the fix  ' }, options);
    expect(hit.status === 'ok' && hit.messages.map(m => m.id)).toEqual(['a']);
    const miss = readAgentChat({ channel: 'engineering', thread: 'run:one', contains: 'deploy the' }, options);
    expect(miss.status === 'ok' && miss.messages.map(m => m.id)).toEqual(['a']);
    const none = readAgentChat({ channel: 'engineering', thread: 'run:one', contains: 'retro' }, options);
    expect(none.status === 'ok' && none.messages).toEqual([]);
    const list = readAgentChat({ channel: 'engineering', contains: 'standup' }, options);
    expect(list.status === 'ok'); if (list.status !== 'ok') return;
    expect(list.threads.map(t => t.id)).toEqual(['run:one']);
    expect(list.threads[0]).toMatchObject({ messageCount: 1 });
  });
  it('applies the shared [since, before) window on receivedAt', () => {
    const options = setup();
    add(options, envelope('old'));
    expect(appendBusInbox(envelope('new'), { ...options, now: () => 2000 }).status).toBe('posted');
    const read = { ...options, now: () => 3000 };
    const ids = (q: Parameters<typeof readAgentChat>[0]) => {
      const result = readAgentChat({ channel: 'engineering', thread: 'run:one', ...q }, read);
      return result.status === 'ok' ? result.messages.map(m => m.id) : result.status;
    };
    expect(ids({ since: 1500 })).toEqual(['new']);
    expect(ids({ before: 1500 })).toEqual(['old']);
    expect(ids({ since: 1000, before: 2000 })).toEqual(['old']);
    expect(ids({ since: 1000 })).toEqual(['old', 'new']);
    expect(ids({ before: 1000 })).toEqual([]);
  });
  it('filters by exact envelope id and by the body inReplyTo citation', () => {
    const options = setup();
    add(options, envelope('a'));
    add(options, envelope('b', { body: { kind: 'note', thread: 'run:one', text: 'answer', inReplyTo: 'a' } }));
    const byId = readAgentChat({ channel: 'engineering', thread: 'run:one', id: 'a' }, options);
    expect(byId.status === 'ok' && byId.messages.map(m => m.id)).toEqual(['a']);
    const missing = readAgentChat({ channel: 'engineering', thread: 'run:one', id: 'zzz' }, options);
    expect(missing.status === 'ok' && missing.messages).toEqual([]);
    const replies = readAgentChat({ channel: 'engineering', thread: 'run:one', inReplyTo: 'a' }, options);
    expect(replies.status === 'ok' && replies.messages.map(m => m.id)).toEqual(['b']);
    const none = readAgentChat({ channel: 'engineering', thread: 'run:one', inReplyTo: 'zzz' }, options);
    expect(none.status === 'ok' && none.messages).toEqual([]);
  });
  it('filters messages and the thread index by the shared P0..P3 priority band', () => {
    const options = setup();
    add(options, envelope('a', { priority: 'P3' }));
    add(options, envelope('b', { priority: 'P0', body: { kind: 'note', thread: 'run:two', text: 'urgent' } }));
    add(options, envelope('c', { priority: 'P1' }));
    const urgent = readAgentChat({ channel: 'engineering', thread: 'run:one', priority: 'P0' }, options);
    expect(urgent.status === 'ok' && urgent.messages).toEqual([]);
    const p3 = readAgentChat({ channel: 'engineering', thread: 'run:one', priority: 'P3' }, options);
    expect(p3.status === 'ok' && p3.messages.map(m => m.id)).toEqual(['a']);
    const list = readAgentChat({ channel: 'engineering', priority: 'P0' }, options);
    expect(list.status === 'ok'); if (list.status !== 'ok') return;
    expect(list.threads.map(t => t.id)).toEqual(['run:two']);
    expect(list.threads[0]).toMatchObject({ messageCount: 1 });
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one', priority: 'P9' as never }, options).status).toBe('invalid');
  });
  it.each([
    { from: '' }, { from: 'x'.repeat(129) }, { excludeFrom: '' }, { excludeFrom: 'x'.repeat(129) },
    { contains: '   ' }, { contains: 'x'.repeat(513) },
    { since: -1 }, { since: 1.5 }, { before: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'has space' }, { id: 'line\nbreak' }, { inReplyTo: '' },
  ] as Partial<Parameters<typeof readAgentChat>[0]>[])('rejects malformed filter %j', query => {
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one', ...query }, setup()).status).toBe('invalid');
  });
  it('CLI and HTTP accept the shared filters and reject bad values', () => {
    let seen: Parameters<typeof readAgentChat>[0] | undefined;
    const read = (q: Parameters<typeof readAgentChat>[0]) => { seen = q; return { status: 'ok' as const, schema: 'agent-chat.v1' as const, channel: 'engineering', asOf: 0, participants: [], threads: [], messages: [], nextCursor: 0, hasMore: false, retention: 'live-retained-only' as const }; };
    const output: string[] = [];
    expect(runAgentsChat(['read', 'run:one', '--channel', 'engineering', '--from', 'bob',
      '--exclude-from', 'carol', '--contains', 'deploy', '--since', '15m', '--before', '2026-01-01T00:00:00Z',
      '--id', 'env-1', '--in-reply-to', 'env-0', '--priority', 'P0', '--json'], s => output.push(s), () => {}, read)).toBe(0);
    expect(seen).toMatchObject({ from: 'bob', excludeFrom: 'carol', contains: 'deploy', id: 'env-1', inReplyTo: 'env-0', priority: 'P0' });
    expect(typeof seen!.since).toBe('number'); expect(typeof seen!.before).toBe('number');
    expect(runAgentsChat(['list', '--channel', 'engineering', '--since', 'bogus', '--json'], () => {}, () => {}, read)).toBe(2);
    expect(runAgentsChat(['list', '--channel', 'engineering', '--priority', 'P9', '--json'], () => {}, () => {}, read)).toBe(2);
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&thread=run:one&from=bob&contains=hi&since=1000&before=2000&id=x&inReplyTo=y&excludeFrom=z&priority=P1', read).code).toBe(200);
    expect(seen).toMatchObject({ from: 'bob', excludeFrom: 'z', contains: 'hi', id: 'x', inReplyTo: 'y', since: 1000, before: 2000, priority: 'P1' });
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&since=bogus', read).code).toBe(400);
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&priority=P9', read).code).toBe(400);
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&from=a&from=b', read).code).toBe(400);
    expect(agentChatResponse('GET', '/api/agents/chat?channel=engineering&root=/tmp', read).code).toBe(400);
  });
});
