import { describe, expect, it } from 'vitest';
import { createBusRouter, createMemoryDeadLetterSink, type TransportEnvelope } from '../src/core/fleet/bus-transport.js';
import {
  ExternalTransportError, createExternalAgentTransport, type ExternalAgentClient,
} from '../src/core/fleet/bus-transport-external.js';

const envelope = (over: Partial<TransportEnvelope> = {}): TransportEnvelope => ({
  id: 'msg-1', from: 'agent:planner', to: 'agent:remote', kind: 'question', priority: 'P2',
  body: { text: 'status?' }, correlationId: 'corr-1', ttlMs: 60_000, ...over,
});

/** In-memory fake of an external agent service; records every contact. */
function fakeClient(overrides: Partial<ExternalAgentClient> = {}) {
  const calls: string[] = [];
  const client: ExternalAgentClient = {
    async send(e) { calls.push(`send:${e.id}`); return { receipt: `remote-${e.id}` }; },
    async poll(since) {
      calls.push(`poll:${since ?? ''}`);
      return {
        next: 'c2',
        messages: [
          { cursor: 'c1', receivedAt: 5, envelope: envelope({ id: 'in-1', from: 'agent:remote', to: 'agent:planner', kind: 'result' }) },
          { cursor: 'c2', receivedAt: 6, envelope: { id: 'bad id', injected: true } },
        ],
      };
    },
    async ack(id) { calls.push(`ack:${id}`); },
    async health() { calls.push('health'); return 'up'; },
    ...overrides,
  };
  return { client, calls };
}

describe('external agent transport (fake)', () => {
  it('is off by default: every operation refuses without contacting the service', async () => {
    const { client, calls } = fakeClient();
    const t = createExternalAgentTransport({ id: 'remote', client });
    expect(t.boundary).toBe('external');
    expect(await t.send(envelope())).toMatchObject({ ok: false, retryable: false });
    expect(await t.poll()).toMatchObject({ ok: false, retryable: false });
    expect(await t.ack('msg-1')).toMatchObject({ ok: false, retryable: false });
    expect(await t.health()).toMatchObject({ state: 'down' });
    expect(calls).toEqual([]);
  });

  it('even when a router is approved, an unapproved adapter refuses and the message dead-letters', async () => {
    const { client, calls } = fakeClient();
    const deadLetter = createMemoryDeadLetterSink();
    const router = createBusRouter({
      egress: { ownerApproved: true }, deadLetter, maxAttempts: 2, sleep: async () => {},
      routes: [{ transport: createExternalAgentTransport({ id: 'remote', client }), roles: ['agent:*'], priority: 0 }],
    });
    // Health reports down without approval, so the adapter is never selected.
    expect(await router.deliver(envelope())).toMatchObject({ status: 'dead-lettered' });
    expect(calls).toEqual([]);
  });

  it('with owner approval, sends, polls, acks and probes through the client', async () => {
    const { client, calls } = fakeClient();
    const t = createExternalAgentTransport({ id: 'remote', client, egress: { ownerApproved: true } });
    expect(await t.health()).toEqual({ state: 'up' });
    expect(await t.send(envelope())).toEqual({ ok: true, receipt: 'remote-msg-1', duplicate: false });
    const page = await t.poll('c0');
    // The malformed inbound envelope is dropped, not passed on.
    expect(page).toEqual({ ok: true, next: 'c2', messages: [{ cursor: 'c1', receivedAt: 5, envelope: expect.objectContaining({ id: 'in-1', kind: 'result' }) }] });
    expect(await t.ack('in-1')).toEqual({ ok: true, replayed: false });
    expect(calls).toEqual(['health', 'send:msg-1', 'poll:c0', 'ack:in-1']);
  });

  it('maps client failures to static reasons and honours the retryable flag', async () => {
    const permanent = createExternalAgentTransport({
      id: 'remote', egress: { ownerApproved: true },
      client: fakeClient({ async send() { throw new ExternalTransportError(false, 'token=abc leaked'); } }).client,
    });
    const transient = createExternalAgentTransport({
      id: 'remote', egress: { ownerApproved: true },
      client: fakeClient({ async send() { throw new Error('https://internal.example/secret'); } }).client,
    });
    const refused = await permanent.send(envelope());
    expect(refused).toMatchObject({ ok: false, retryable: false });
    const retry = await transient.send(envelope());
    expect(retry).toMatchObject({ ok: false, retryable: true });
    expect(JSON.stringify([refused, retry])).not.toMatch(/token|example|secret/);
  });

  it('times out a hung call and aborts its signal', async () => {
    let aborted = false;
    const t = createExternalAgentTransport({
      id: 'remote', egress: { ownerApproved: true }, timeoutMs: 5,
      client: fakeClient({
        send: (_e, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }),
        health: () => new Promise(() => {}),
      }).client,
    });
    expect(await t.send(envelope())).toMatchObject({ ok: false, retryable: true });
    expect(aborted).toBe(true);
    expect(await t.health()).toMatchObject({ state: 'down' });
  });

  it('treats a missing receipt as a retryable failure', async () => {
    const t = createExternalAgentTransport({
      id: 'remote', egress: { ownerApproved: true },
      client: fakeClient({ async send() { return { receipt: '' }; } }).client,
    });
    expect(await t.send(envelope())).toMatchObject({ ok: false, retryable: true });
  });

  it('routes to the approved adapter and retries it before succeeding', async () => {
    let sends = 0;
    const { client } = fakeClient({
      async send(e) {
        sends++;
        if (sends < 2) throw new ExternalTransportError(true);
        return { receipt: `remote-${e.id}`, duplicate: false };
      },
    });
    const sleeps: number[] = [];
    const router = createBusRouter({
      egress: { ownerApproved: true }, deadLetter: createMemoryDeadLetterSink(),
      backoff: { baseMs: 50 }, sleep: async ms => { sleeps.push(ms); },
      routes: [{ transport: createExternalAgentTransport({ id: 'remote', client, egress: { ownerApproved: true } }), roles: ['agent:*'], priority: 0 }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'delivered', transport: 'remote', receipt: 'remote-msg-1' });
    expect(sleeps).toEqual([50]);
  });
});
