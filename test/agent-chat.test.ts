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
});
