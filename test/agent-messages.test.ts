import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter, scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import {
  formatAgentMessagesText, parseAgentMessagesQuery, parseSince, readAgentMessages,
} from '../src/core/fleet/agent-messages.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function store() {
  const root = mkdtempSync(join(tmpdir(), 'agent-messages-'));
  roots.push(root);
  return root;
}
function post(root: string, at: number, envelope: Record<string, unknown>) {
  const result = appendBusInbox({ priority: 'P2', ttl: 86_400_000, ...envelope }, { root, now: () => at });
  expect(result.status).toBe('posted');
}
const read = (root: string, query = {}, now = T0 + 60_000) => readAgentMessages(query, { root, now: () => now });

describe('phm messages projection', () => {
  it('reads an empty bus as missing with no messages', () => {
    const root = store();
    expect(read(root)).toEqual({ schema: 'agent-messages.v1', source: 'missing', messages: [], matched: 0, skipped: 0 });
    expect(formatAgentMessagesText(read(root))).toBe('No agent messages.');
  });

  it('follows a handoff chain across three agents, newest first, in one conversation', () => {
    const root = store();
    post(root, T0, { id: 'm1', from: 'agent:claude-1', to: 'agent:codex-local-2', channel: 'handoff', channel_ref: 'agent:codex-local-2',
      sender: { agent_id: 'agent:claude-1', vendor: 'claude', human: false, team: true }, external: false,
      body: { kind: 'worker-handoff', taskId: 'RQ-CHAINA1', prompt: 'Take over the parser fix', thread: 't-chain' } });
    post(root, T0 + 1_000, { id: 'm2', from: 'agent:codex-local-2', to: 'agent:grok-3',
      body: { kind: 'note', text: 'Can you review ashlrai/phantom#6670 before I hand off?', thread: 't-chain' } });
    post(root, T0 + 2_000, { id: 'm3', from: 'agent:grok-3', to: 'agent:claude-1',
      body: { kind: 'note', text: 'Reviewed, looks good', replyTo: 'm2' } });
    const result = read(root);
    expect(result.messages.map(m => [m.id, m.kind, m.from.name, m.to.name])).toEqual([
      ['m3', 'reply', 'grok-3', 'claude-1'],
      ['m2', 'ask', 'codex-local-2', 'grok-3'],
      ['m1', 'handoff', 'claude-1', 'codex-local-2'],
    ]);
    expect(new Set(result.messages.map(m => m.conversation))).toEqual(new Set(['t-chain']));
    expect(result.messages[2]).toMatchObject({ job: 'RQ-CHAINA1', from: { lane: 'claude' }, to: { lane: 'codex-local' }, ts: new Date(T0).toISOString() });
    expect(result.messages[1]).toMatchObject({ pr: 'ashlrai/phantom#6670', job: null });
    expect(read(root, { agent: 'grok-3' }).messages.map(m => m.id)).toEqual(['m3', 'm2']);
    expect(read(root, { since: T0 + 1_500 }).messages.map(m => m.id)).toEqual(['m3']);
    expect(read(root, { limit: 1 })).toMatchObject({ matched: 3, messages: [{ id: 'm3' }] });
    expect(formatAgentMessagesText(read(root))).toContain('handoff claude-1 (claude) → codex-local-2 (codex-local): Take over the parser fix  [RQ-CHAINA1]');
  });

  it('skips and counts a malformed record instead of failing the whole read', () => {
    const root = store();
    post(root, T0, { id: 'good-1', from: 'a', to: 'b', body: { kind: 'note', text: 'first' } });
    post(root, T0 + 1, { id: 'good-2', from: 'b', to: 'a', body: { kind: 'note', text: 'second' } });
    const file = join(root, 'bus-inbox', 'messages.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { rows: unknown[] };
    snapshot.rows.splice(1, 0, { cursor: 'x', receivedAt: T0, envelope: { id: 'broken' } });
    writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    // The strict writer path still refuses damaged storage.
    expect(listBusInboxAfter(0, 50, { root, now: () => T0 + 10 }).status).toBe('unavailable');
    expect(scanBusInbox({ root, now: () => T0 + 10 })).toMatchObject({ source: 'available', skipped: 1 });
    const result = read(root);
    expect(result).toMatchObject({ source: 'available', skipped: 1, matched: 2 });
    expect(result.messages.map(m => m.id)).toEqual(['good-2', 'good-1']);
    expect(formatAgentMessagesText(result)).toContain('Skipped 1 damaged bus record.');
  });

  it('redacts a secret-shaped value from summaries', () => {
    const root = store();
    const secret = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    post(root, T0, { id: 's1', from: 'claude', to: 'codex-cmp', body: { kind: 'note', text: `use token ${secret} for the push` } });
    const out = JSON.stringify(read(root));
    expect(out).not.toContain(secret);
    expect(read(root).messages[0]!.summary).toMatch(/^use token .*REDACTED.* for the push$/i);
  });

  it('emits stable JSON: fixed key order and deterministic output', () => {
    const root = store();
    post(root, T0, { id: 'k1', from: 'claude', to: 'grok', body: { kind: 'cos-blocked', reason: 'CI red on master' } });
    post(root, T0, { id: 'k2', from: 'grok', to: 'claude', body: { kind: 'work.status', status: 'running' } });
    const first = JSON.stringify(read(root)), second = JSON.stringify(read(root));
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as { messages: Record<string, unknown>[] };
    expect(Object.keys(parsed)).toEqual(['schema', 'source', 'messages', 'matched', 'skipped']);
    expect(Object.keys(parsed.messages[0]!)).toEqual(['id', 'ts', 'from', 'to', 'kind', 'summary', 'conversation', 'job', 'pr']);
    // Same timestamp: cursor order breaks the tie, newest cursor first.
    expect(parsed.messages.map(m => [m.id, m.kind])).toEqual([['k2', 'status'], ['k1', 'blocker']]);
  });

  it('validates flags and reads relative --since', () => {
    expect(parseSince('15m', T0)).toBe(T0 - 900_000);
    expect(parseSince('2026-11-17T00:00:00Z')).toBe(Date.UTC(2026, 10, 17));
    expect(parseSince('soon')).toBeNull();
    expect(parseAgentMessagesQuery({ limit: '0' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ limit: '5000' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ agent: 'bad name' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ since: '1h', agent: 'claude', limit: '10' }, T0)).toEqual({ ok: true, query: { since: T0 - 3_600_000, agent: 'claude', limit: 10 } });
  });

  it('serves the same read at GET /api/verse/agent-bus/messages', async () => {
    const calls: unknown[] = [];
    const api = createAgentBusApi({ messages: query => { calls.push(query); return { schema: 'agent-messages.v1', source: 'missing', messages: [], matched: 0, skipped: 0 }; } });
    const ctx = { readSession: { expiresAt: Date.now() + 60_000 } } as never;
    const send = async (url: string) => {
      let status = 0, body = '';
      const res = { writeHead: (s: number) => { status = s; return res; }, setHeader: () => res, end: (b?: string) => { body = b ?? ''; }, statusCode: 0 } as never;
      const handled = await api(ctx, { url, headers: {} } as never, res, url.split('?')[0]!, 'GET');
      return { handled, status: status || (res as { statusCode: number }).statusCode, body };
    };
    const ok = await send('/api/verse/agent-bus/messages?agent=claude&limit=5');
    expect(ok.handled).toBe(true);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ schema: 'agent-messages.v1' });
    expect(calls).toEqual([{ agent: 'claude', limit: 5 }]);
    expect((await send('/api/verse/agent-bus/messages?limit=0')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?after=1')).status).toBe(400);
  });
});
