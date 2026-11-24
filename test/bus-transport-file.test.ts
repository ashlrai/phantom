import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { createBusRouter, localBusHold, type TransportEnvelope } from '../src/core/fleet/bus-transport.js';
import {
  BUS_DEAD_LETTER_ADDRESS, createFileBusTransport, createFileDeadLetterSink,
} from '../src/core/fleet/bus-transport-file.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-transport-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const envelope = (over: Partial<TransportEnvelope> = {}): TransportEnvelope => ({
  id: 'msg-1', from: 'agent:planner', to: 'reviewer', kind: 'task', priority: 'P1',
  body: { text: 'review this' }, correlationId: 'corr-1', ttlMs: 60_000, ...over,
});

describe('file bus transport', () => {
  it('sends through the existing bus inbox and polls back only its addresses', async () => {
    const root = setup();
    const reviewer = createFileBusTransport({ root, addresses: ['reviewer'], now: () => 5_000 });
    expect(await reviewer.send(envelope())).toEqual({ ok: true, receipt: 'cursor:1', duplicate: false });
    expect(await reviewer.send(envelope({ id: 'msg-2', to: 'agent:other' }))).toMatchObject({ ok: true });
    // Same store the rest of the bus reads: the post is a plain bus v1 envelope.
    const raw = listBusInboxAfter(0, 10, { root, now: () => 5_000 });
    expect(raw.status === 'ok' && raw.messages.map(m => m.envelope.id)).toEqual(['msg-1', 'msg-2']);

    const page = await reviewer.poll();
    expect(page).toMatchObject({ ok: true, next: '2' });
    if (!page.ok) throw new Error('unreachable');
    expect(page.messages.map(m => m.envelope)).toEqual([envelope()]);
    expect(page.messages[0]!.cursor).toBe('1');
    expect(await reviewer.poll('2')).toEqual({ ok: true, messages: [], next: '2' });
  });

  it('maps duplicate and conflicting ids', async () => {
    const root = setup();
    const t = createFileBusTransport({ root, addresses: ['*'] });
    await t.send(envelope());
    expect(await t.send(envelope())).toEqual({ ok: true, receipt: 'cursor:1', duplicate: true });
    expect(await t.send(envelope({ body: { text: 'different' } }))).toMatchObject({ ok: false, retryable: false });
  });

  it('skips bus traffic that was not written by a transport', async () => {
    const root = setup();
    appendBusInbox({ id: 'legacy', from: 'a', to: 'reviewer', priority: 'P2', ttl: 60_000, body: { kind: 'note', text: 'hi' } }, { root });
    const t = createFileBusTransport({ root, addresses: ['reviewer'] });
    expect(await t.poll()).toEqual({ ok: true, messages: [], next: '1' });
  });

  it('acks durably in a private ledger, and acked messages leave poll', async () => {
    const root = setup();
    const t = createFileBusTransport({ root, addresses: ['reviewer'] });
    await t.send(envelope());
    await t.send(envelope({ id: 'msg-2' }));
    expect(await t.ack('msg-1')).toEqual({ ok: true, replayed: false });
    expect(await t.ack('msg-1')).toEqual({ ok: true, replayed: true });
    const ledger = join(root, 'bus-transport', 'acks.json');
    if (process.platform !== 'win32') expect(statSync(ledger).mode & 0o777).toBe(0o600);

    // A fresh instance sees the same acks.
    const again = createFileBusTransport({ root, addresses: ['reviewer'] });
    const page = await again.poll();
    expect(page.ok && page.messages.map(m => m.envelope.id)).toEqual(['msg-2']);
  });

  it('refuses to ack a message this consumer does not read', async () => {
    const root = setup();
    const writer = createFileBusTransport({ root, addresses: ['*'] });
    await writer.send(envelope({ to: 'agent:other' }));
    const reviewer = createFileBusTransport({ root, addresses: ['reviewer'] });
    expect(await reviewer.ack('msg-1')).toMatchObject({ ok: false, retryable: false });
    expect(await reviewer.ack('missing')).toMatchObject({ ok: false, retryable: false });
  });

  it('prunes acks for messages the inbox no longer keeps alive', async () => {
    const root = setup();
    let now = 1_000;
    const t = createFileBusTransport({ root, addresses: ['reviewer'], now: () => now });
    await t.send(envelope({ id: 'short', ttlMs: 10 }));
    await t.send(envelope({ id: 'long' }));
    expect(await t.ack('short')).toMatchObject({ ok: true });
    now += 100;
    expect(await t.ack('long')).toMatchObject({ ok: true });
    const rows = JSON.parse((await import('node:fs')).readFileSync(join(root, 'bus-transport', 'acks.json'), 'utf8'));
    expect(rows).toEqual({ version: 1, acks: [{ id: 'long', to: 'reviewer' }] });
  });

  it('reports health and fails closed on a damaged ack ledger', async () => {
    const root = setup();
    const t = createFileBusTransport({ root, addresses: ['reviewer'] });
    expect(await t.health()).toEqual({ state: 'up' });
    await t.send(envelope());
    await t.ack('msg-1');
    writeFileSync(join(root, 'bus-transport', 'acks.json'), '{"version":1,"acks":"nope"}', { mode: 0o600 });
    expect(await t.health()).toMatchObject({ state: 'down' });
    expect(await t.poll()).toMatchObject({ ok: false, retryable: false });
  });

  it('rejects malformed cursors and options', async () => {
    const root = setup();
    const t = createFileBusTransport({ root, addresses: ['reviewer'] });
    expect(await t.poll('-1')).toMatchObject({ ok: false });
    expect(await t.poll('abc')).toMatchObject({ ok: false });
    expect(await t.poll('99')).toMatchObject({ ok: false });
    expect(() => createFileBusTransport({ root, addresses: [] })).toThrow(TypeError);
    expect(() => createFileBusTransport({ root, addresses: ['x'], pageSize: 0 })).toThrow(TypeError);
  });
});

describe('file dead-letter sink', () => {
  it('records dead letters on the bus under the reserved address and dedupes retries', async () => {
    const root = setup();
    const router = createBusRouter({
      maxAttempts: 2, sleep: async () => {},
      deadLetter: createFileDeadLetterSink({ root }),
      routes: [{
        roles: ['*'], priority: 0,
        transport: {
          id: 'broken', boundary: 'local',
          async send() { return { ok: false, retryable: true, reason: 'busy' }; },
          async poll() { return { ok: true, messages: [], next: '0' }; },
          async ack() { return { ok: true, replayed: false }; },
          async health() { return { state: 'up' }; },
        },
      }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'dead-lettered', reason: 'exhausted', recorded: true });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'dead-lettered', recorded: true });

    const reader = createFileBusTransport({ root, addresses: [BUS_DEAD_LETTER_ADDRESS] });
    const page = await reader.poll();
    if (!page.ok) throw new Error('poll failed');
    expect(page.messages).toHaveLength(1);
    const letter = page.messages[0]!.envelope;
    expect(letter).toMatchObject({ to: BUS_DEAD_LETTER_ADDRESS, kind: 'status', correlationId: 'corr-1' });
    expect(letter.body).toMatchObject({
      payloadDropped: false, envelope: envelope(),
      deadLetter: { id: 'msg-1', reason: 'exhausted', attempts: [{ outcome: 'retryable' }, { outcome: 'retryable' }] },
    });
    // Ordinary consumers never see dead letters.
    const reviewer = createFileBusTransport({ root, addresses: ['reviewer'] });
    expect(await reviewer.poll()).toMatchObject({ ok: true, messages: [] });
  });

  it('keeps routing metadata when the original payload is too large to wrap', async () => {
    const root = setup();
    const sink = createFileDeadLetterSink({ root });
    const big = envelope({ body: { text: 'x'.repeat(65_000) } });
    expect(await sink.put({ envelope: big, reason: 'exhausted', attempts: [], deadLetteredAt: 1 })).toEqual({ ok: true });
    const page = await createFileBusTransport({ root, addresses: [BUS_DEAD_LETTER_ADDRESS] }).poll();
    if (!page.ok) throw new Error('poll failed');
    expect(page.messages[0]!.envelope.body).toMatchObject({ payloadDropped: true, envelope: null, deadLetter: { id: 'msg-1' } });
  });
});

describe('end to end', () => {
  it('routes a role to the file bus and the recipient polls and acks it', async () => {
    const root = setup();
    const router = createBusRouter({
      deadLetter: createFileDeadLetterSink({ root }),
      routes: [{ transport: createFileBusTransport({ root, addresses: ['*'] }), roles: ['reviewer', 'agent:*'], priority: 0 }],
    });
    const report = await router.deliver(envelope());
    expect(report).toMatchObject({ status: 'delivered', transport: 'file-bus', receipt: 'cursor:1' });
    const inbox = createFileBusTransport({ root, addresses: ['reviewer'] });
    const page = await inbox.poll();
    expect(page.ok && page.messages[0]!.envelope.correlationId).toBe('corr-1');
    expect(await inbox.ack('msg-1')).toMatchObject({ ok: true });
    expect(await inbox.poll()).toMatchObject({ ok: true, messages: [] });
  });

  it('defaults the router hold to the local kill-switch and pause gate', () => {
    // The isolated test home has neither a kill switch nor a pause.
    expect(localBusHold()).toBeNull();
  });
});
