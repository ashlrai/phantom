import { describe, expect, it } from 'vitest';
import { runBusRequestWait } from '../examples/agents/bus-request-wait.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const request: BusEnvelope = { id: 'fake-request', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60_000, body: { text: 'fixture' } };
const reply = (id: string, to: string, replyTo: string): BusEnvelope => ({
  id, from: 'fake-b', to, priority: 'P2', ttl: 60_000, body: { replyTo, text: 'fixture reply' },
});

function fixture(input = JSON.stringify(request)) {
  const rows: BusInboxReceipt[] = [];
  const output: Record<string, unknown>[] = [];
  let time = 0, posts = 0, waits = 0;
  const add = (envelope: BusEnvelope): void => { rows.push({ cursor: rows.length + 1, receivedAt: 0, envelope }); };
  const deps = {
    readFile: () => input,
    read: (after = 0, limit = 50) => {
      const messages = rows.slice(after, after + limit);
      return { status: 'ok' as const, messages, nextCursor: after + messages.length };
    },
    post: (envelope: unknown) => {
      posts++;
      add(envelope as BusEnvelope);
      return { status: 'posted' as const, id: request.id, cursor: rows.length };
    },
    now: () => time,
    wait: async (ms: number) => { waits++; time += ms; },
    write: (line: string) => { output.push(JSON.parse(line) as Record<string, unknown>); },
  };
  return { deps, add, output, counts: () => ({ posts, waits }) };
}
const args = ['--file', 'fake-envelope.json', '--timeout-ms', '500'];

describe('bus request and wait example', () => {
  it('captures the cursor before posting and finds an immediate reply', async () => {
    const f = fixture();
    f.add(reply('old-reply', 'fake-a', request.id));
    const post = f.deps.post;
    f.deps.post = envelope => { const result = post(envelope); f.add(reply('new-reply', 'fake-a', request.id)); return result; };
    expect(await runBusRequestWait(args, f.deps)).toBe(0);
    expect(f.output[0]).toMatchObject({ status: 'reply', reply: { envelope: { id: 'new-reply' } } });
    expect(f.counts()).toEqual({ posts: 1, waits: 0 });
  });

  it('ignores unrelated addresses and correlations while scanning multiple pages', async () => {
    const f = fixture();
    const post = f.deps.post;
    f.deps.post = envelope => {
      const result = post(envelope);
      for (let i = 0; i < 105; i++) f.add(reply(`fake-${i}`, i % 2 ? 'fake-a' : 'fake-other', 'other-request'));
      f.add(reply('wrong-address', 'fake-other', request.id));
      f.add(reply('matched', 'fake-a', request.id));
      return result;
    };
    expect(await runBusRequestWait(args, f.deps)).toBe(0);
    expect(f.output[0]).toMatchObject({ status: 'reply', reply: { envelope: { id: 'matched' } } });
    expect(f.counts().posts).toBe(1);
  });

  it('times out without reposting', async () => {
    const f = fixture();
    expect(await runBusRequestWait(args, f.deps)).toBe(5);
    expect(f.output[0]).toMatchObject({ status: 'timeout', post: { status: 'posted' } });
    expect(f.counts()).toEqual({ posts: 1, waits: 2 });
  });

  it('rejects an invalid envelope before any write', async () => {
    const f = fixture('{"id":"bad"}');
    expect(await runBusRequestWait(args, f.deps)).toBe(2);
    expect(f.output[0]).toMatchObject({ status: 'invalid-envelope' });
    expect(f.counts().posts).toBe(0);
  });

  it.each(['full', 'conflict', 'retryable', 'unavailable'] as const)('reports %s acceptance failure explicitly', async status => {
    const f = fixture();
    let calls = 0;
    expect(await runBusRequestWait(args, { ...f.deps, post: () => { calls++; return { status }; } })).toBe(3);
    expect(f.output[0]).toMatchObject({ status: 'post-failed', reason: status, acceptance: status === 'unavailable' ? 'unknown' : 'rejected' });
    expect(calls).toBe(1);
    expect(f.counts().waits).toBe(0);
  });

  it('reports a thrown post as uncertain and never retries', async () => {
    const f = fixture();
    let calls = 0;
    expect(await runBusRequestWait(args, { ...f.deps, post: () => { calls++; throw new Error('fake'); } })).toBe(3);
    expect(f.output[0]).toMatchObject({ status: 'post-failed', reason: 'unavailable', acceptance: 'unknown' });
    expect(calls).toBe(1);
  });

  it('does not post if cursor capture fails', async () => {
    const f = fixture();
    expect(await runBusRequestWait(args, { ...f.deps, read: () => ({ status: 'unavailable' }) })).toBe(4);
    expect(f.output[0]).toMatchObject({ status: 'read-failed', phase: 'cursor', reason: 'unavailable' });
    expect(f.counts().posts).toBe(0);
  });

  it('reports interruption after acceptance and stops waiting', async () => {
    const f = fixture(), controller = new AbortController();
    const wait = async (): Promise<void> => { controller.abort(); };
    expect(await runBusRequestWait(args, { ...f.deps, wait, signal: controller.signal })).toBe(130);
    expect(f.output[0]).toMatchObject({ status: 'interrupted', post: { status: 'posted' } });
    expect(f.counts().posts).toBe(1);
  });
});
