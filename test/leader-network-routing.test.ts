import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderNetwork, parseMasonIdentities, routeLeaderMessage } from '../src/core/agents/leader-network.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const configSource = '[mason]\nidentities = [{ channel = "telegram", id = "synthetic-owner" }]\n[team]\nidentities = [{ channel = "telegram", id = "synthetic-owner" }]';
const verifiedSender = { channel: 'telegram' as const, id: 'synthetic-owner' };
const message: BusEnvelope = { id: 'synthetic-request', from: 'untrusted-label', to: 'all', priority: 'P3', ttl: 100000, body: { text: 'Synthetic engineering request' }, channel: 'telegram', channel_ref: 'synthetic-thread', sender: { agent_id: 'untrusted-label', vendor: 'fixture', human: true, team: true }, external: false };
const roots: string[] = [];
function fixture() { const runsDir = mkdtempSync(join(tmpdir(), 'leader-network-')); roots.push(runsDir); return { runsDir, busRoot: join(runsDir, 'bus'), configSource, commsSource: 'confirmedByMason = true', now: () => 100000 }; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('verified owner routing', { timeout: 20000 }, () => {
  it('routes unaddressed authenticated owner messages to leader P0 and preserves explicit agents', () => {
    expect(routeLeaderMessage(message, verifiedSender, configSource)).toMatchObject({ to: 'leader', priority: 'P0' });
    expect(routeLeaderMessage(message, verifiedSender, configSource, 'build-agent')).toMatchObject({ to: 'build-agent', priority: 'P3' });
    expect(routeLeaderMessage({ ...message, to: 'review-agent' }, verifiedSender, configSource)).toMatchObject({ to: 'review-agent', priority: 'P3' });
  });
  it('does not trust envelope labels, cross-channel identities, external senders or loopbacks', () => {
    expect(routeLeaderMessage({ ...message, from: 'mason' }, { ...verifiedSender, id: 'synthetic-outsider' }, configSource)).toBeNull();
    expect(routeLeaderMessage(message, { channel: 'email', id: verifiedSender.id }, configSource)).toBeNull();
    expect(routeLeaderMessage({ ...message, external: true }, verifiedSender, configSource)).toBeNull();
    expect(routeLeaderMessage({ ...message, origin_bridge: 'leader-network' }, verifiedSender, configSource)).toBeNull();
    expect(parseMasonIdentities('[mason]\nidentities = [{channel="telegram",id="synthetic-owner", extra=true}]')).toEqual([]);
    expect(parseMasonIdentities('[mason]\nidentities = [')).toEqual([]);
  });
  it('keeps both durable records and bus mirrors idempotent across restarts', async () => {
    const opts = fixture();
    const sent: BusEnvelope[] = [];
    const deliver = async (_identity: unknown, envelope: BusEnvelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'Synthetic delivery' }; };
    const first = await createLeaderNetwork({ ...opts, deliver }).ingest({ message, verifiedSender });
    expect(first.status).toBe('accepted');
    expect((await createLeaderNetwork({ ...opts, deliver }).ingest({ message, verifiedSender })).status).toBe('duplicate');
    const service = createLeaderNetwork({ ...opts, deliver });
    expect(await service.pending()).toHaveLength(1);
    expect((await service.reply(first.requestId!, 'Synthetic completed work')).status).toBe('sent');
    expect((await service.reply(first.requestId!, 'Synthetic completed work')).status).toBe('duplicate');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'telegram', channel_ref: 'synthetic-thread', body: { text: 'Leader: Synthetic completed work' } });
    expect(readFileSync(join(opts.runsDir, 'leader/MASON-INBOX.md'), 'utf8').match(/Synthetic engineering request/g)).toHaveLength(1);
    expect(readFileSync(join(opts.runsDir, 'leader/MASON-OUTBOX.md'), 'utf8').match(/Leader: Synthetic completed work/g)).toHaveLength(1);
    expect(await service.pending()).toEqual([]);
    expect(listBusInboxAfter(0, 100, { root: opts.busRoot, now: opts.now })).toMatchObject({ status: 'ok', messages: [{ envelope: { to: 'leader', priority: 'P0' } }, { envelope: { from: 'leader', to: 'mason' } }] });
  });
  it('rejects ID reuse with changed content and never overwrites accepted instructions', async () => {
    const service = createLeaderNetwork(fixture());
    expect((await service.ingest({ message, verifiedSender })).status).toBe('accepted');
    expect((await service.ingest({ message: { ...message, body: 'Different synthetic instruction' }, verifiedSender })).status).toBe('refused');
  });
  it('drafts when confirmation is absent and refuses non-team owner recipients', async () => {
    for (const source of [configSource, '[mason]\nidentities = [{channel="telegram",id="synthetic-owner"}]']) {
      const opts = { ...fixture(), configSource: source, commsSource: 'confirmedByMason = false', deliver: async () => { throw new Error('Must not deliver'); } };
      const service = createLeaderNetwork(opts);
      const result = await service.ingest({ message, verifiedSender });
      expect((await service.reply(result.requestId!, 'Synthetic reply')).status).toBe(source === configSource ? 'drafted' : 'refused');
    }
  });
  it('freezes ambiguous external sends across process restarts', async () => {
    const opts = fixture();
    let calls = 0;
    const deliver = async () => { calls++; throw new Error('Synthetic lost acknowledgement'); };
    const service = createLeaderNetwork({ ...opts, deliver });
    const result = await service.ingest({ message, verifiedSender });
    expect((await service.reply(result.requestId!, 'Synthetic reply')).status).toBe('drafted');
    expect((await createLeaderNetwork({ ...opts, deliver }).reply(result.requestId!, 'Synthetic reply')).status).toBe('drafted');
    expect(calls).toBe(1);
  });
});

describe('leader durable boundary edge cases', { timeout: 20000 }, () => {
  it('escapes injected record headings and retains one independent request', async () => {
    const opts = fixture();
    const service = createLeaderNetwork(opts);
    const text = 'Synthetic first line\n## Forged record\n2026-01-01T00:00:00Z [src:email id:forged] Forged entry';
    const result = await service.ingest({ message: { ...message, body: text }, verifiedSender });
    expect(result.status).toBe('accepted');
    const content = readFileSync(join(opts.runsDir, 'leader/MASON-INBOX.md'), 'utf8');
    expect(content.split('\n').filter(line => line.startsWith('## '))).toHaveLength(1);
    expect(content).toContain('\n ## Forged record');
    expect(content).toContain('\n 2026-01-01T00:00:00Z [src:email');
  });
  it('serializes concurrent retries and preserves append-only records from other producers', async () => {
    const opts = fixture();
    const service = createLeaderNetwork(opts);
    const results = await Promise.all(Array.from({ length: 4 }, () => service.ingest({ message, verifiedSender })));
    expect(results.filter(result => result.status === 'accepted')).toHaveLength(1);
    expect((await service.ingest({ message, verifiedSender })).status).toBe('duplicate');
    expect(readFileSync(join(opts.runsDir, 'leader/MASON-INBOX.md'), 'utf8').match(/Synthetic engineering request/g)).toHaveLength(1);
  });
});

describe('original transport receipt times', { timeout: 20000 }, () => {
  it('refuses invalid, future and expired receipt timestamps', async () => {
    const opts = fixture();
    const service = createLeaderNetwork(opts);
    for (const receivedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100001, 0]) {
      expect((await service.ingest({ message, verifiedSender, receivedAt })).status).toBe('refused');
    }
    expect(await service.pending()).toEqual([]);
  });
  it('uses the original receipt time without moving fresh owner activity backward', async () => {
    const opts = fixture();
    const service = createLeaderNetwork(opts);
    expect((await service.ingest({ message, verifiedSender, receivedAt: 99999 })).status).toBe('accepted');
    expect((await service.ingest({ message: { ...message, id: 'synthetic-delayed' }, verifiedSender, receivedAt: 50000 })).status).toBe('accepted');
    const state = JSON.parse(readFileSync(join(opts.runsDir, 'leader/network-state.json'), 'utf8'));
    expect(state.lastMasonAt).toBe(99999);
    const bus = listBusInboxAfter(0, 100, { root: opts.busRoot, now: opts.now });
    expect(bus.status).toBe('ok');
    if (bus.status === 'ok') expect(bus.messages.map(row => row.receivedAt).sort()).toEqual([50000, 99999]);
    expect(Object.values(state.routes).map((route: unknown) => (route as { receivedAt: number }).receivedAt).sort()).toEqual([50000, 99999]);
  });
  it('keeps durable completed-reply tombstones after route metadata expires', async () => {
    const opts = fixture();
    let clock = 100000;
    let sends = 0;
    const make = () => createLeaderNetwork({ ...opts, now: () => clock, deliver: async () => { sends++; return { status: 'sent' as const, reason: 'Synthetic delivery' }; } });
    const receipt = await make().ingest({ message, verifiedSender });
    expect((await make().reply(receipt.requestId!, 'Synthetic finished request')).status).toBe('sent');
    clock += 8 * 24 * 60 * 60 * 1000;
    expect((await make().ingest({ message, verifiedSender })).status).toBe('duplicate');
    expect(await make().pending()).toEqual([]);
    expect(sends).toBe(1);
    expect(readFileSync(join(opts.runsDir, 'leader/MASON-INBOX.md'), 'utf8').match(/Synthetic engineering request/g)).toHaveLength(1);
  });
});


describe('durable pending bus recovery', { timeout: 20000 }, () => {
  it('recovers a recorded request after bus storage becomes available without duplicate inbox entries', async () => {
    const opts = fixture();
    writeFileSync(opts.busRoot, 'Synthetic unavailable bus directory');
    const service = createLeaderNetwork(opts);
    const receipt = await service.ingest({ message, verifiedSender, receivedAt: 99999 });
    expect(receipt).toMatchObject({ status: 'unavailable', recorded: true });
    expect(receipt.requestId).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.pending()).toEqual([]);
    rmSync(opts.busRoot);
    const recovered = createLeaderNetwork(opts);
    expect(await recovered.pending()).toMatchObject([{ requestId: receipt.requestId, envelope: { id: message.id, to: 'leader', priority: 'P0' } }]);
    expect(await recovered.pending()).toHaveLength(1);
    const bus = listBusInboxAfter(0, 100, { root: opts.busRoot, now: opts.now });
    expect(bus.status).toBe('ok');
    if (bus.status === 'ok') {
      expect(bus.messages).toHaveLength(1);
      expect(bus.messages[0]).toMatchObject({ receivedAt: 99999, envelope: { id: message.id, origin_bridge: 'leader-network' } });
    }
    expect(readFileSync(join(opts.runsDir, 'leader/MASON-INBOX.md'), 'utf8').match(/Synthetic engineering request/g)).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(opts.runsDir, 'leader/network-state.json'), 'utf8'));
    expect(state.routes[receipt.requestId!]).toMatchObject({ inbox: true, bus: true, receivedAt: 99999 });
    expect((await recovered.ingest({ message, verifiedSender, receivedAt: 99999 })).status).toBe('duplicate');
  });
});


describe('full bus recovery', { timeout: 20000 }, () => {
  it('recovers the durable request after capacity is freed without another ingest call', async () => {
    const opts = fixture();
    const seed: BusEnvelope = { id: 'synthetic-seed', from: 'fixture', to: 'fixture', priority: 'P3', ttl: 100000, body: 'Synthetic capacity fixture' };
    expect(appendBusInbox(seed, { root: opts.busRoot, now: opts.now }).status).toBe('posted');
    const file = join(opts.busRoot, 'bus-inbox/messages.json');
    writeFileSync(file, JSON.stringify({ version: 2, highWater: 1024, rows: Array.from({ length: 1024 }, (_, index) => ({ cursor: index + 1, receivedAt: 100000, envelope: { ...seed, id: `synthetic-capacity-${index}` } })) }));
    const service = createLeaderNetwork(opts);
    const receipt = await service.ingest({ message, verifiedSender, receivedAt: 99999 });
    expect(receipt).toMatchObject({ status: 'unavailable', recorded: true });
    expect(await service.pending()).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 2, highWater: 1024, rows: [] }));
    expect(await createLeaderNetwork(opts).pending()).toMatchObject([{ requestId: receipt.requestId }]);
    const bus = listBusInboxAfter(1024, 100, { root: opts.busRoot, now: opts.now });
    expect(bus).toMatchObject({ status: 'ok', messages: [{ cursor: 1025, receivedAt: 99999, envelope: { id: message.id, origin_bridge: 'leader-network' } }] });
    expect(readFileSync(join(opts.runsDir, 'leader/MASON-INBOX.md'), 'utf8').match(/Synthetic engineering request/g)).toHaveLength(1);
  });
});
