import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannelReceiver, type ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';
import { publishChannelEnvelope, buildChannelBusEnvelope } from '../src/core/fleet/channel-bus-publish.js';
import { QueueStore } from '../src/core/queue/store.js';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const message = { channel: 'email' as const, verifiedSenderId: 'fake-mason', body: 'fake café\nshared order' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fake-channel-recovery-'));
  roots.push(root);
  const runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
  let time = Date.parse('2026-10-31T00:13:00Z');
  const options = { runsDir, busRoot, allowedSenderIds: new Set(['fake-mason']), now: () => new Date(time) };
  const receiptPath = join(runsDir, 'channel-receipts', 'receipts.json');
  const busPath = join(busRoot, 'bus-inbox', 'messages.json');
  const rows = (): BusInboxReceipt[] => {
    if (!existsSync(busPath)) return [];
    const snapshot = JSON.parse(readFileSync(busPath, 'utf8')) as { version: number; highWater: number; rows: BusInboxReceipt[] };
    expect(snapshot.version).toBe(2);
    expect(snapshot.highWater).toBeGreaterThanOrEqual(snapshot.rows.length);
    return snapshot.rows;
  };
  const inboxCount = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8').match(/^\d{4}-.* \[src:/gm)?.length;
  const publish = async (envelope: ChannelEnvelope) => {
    expect(await publishChannelEnvelope(envelope, { root: busRoot, now: () => time })).toBe('published');
  };
  return { root, options, receiptPath, rows, inboxCount, publish, advance: () => { time += 1000; } };
}
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('durable channel mirror recovery solu1', () => {
  it.each(['email', 'telegram'] as const)('recovers after restart through %s with the same body and receivedAt pinned', async (channel) => {
    const s = fixture();
    const acknowledge = vi.fn(async () => {});
    const failed = vi.fn(async () => { throw new Error('fake initial outage'); });
    const exact = { ...message, channel, threadId: 'fake-thread-1' };
    const first = await createChannelReceiver({ ...s.options, publish: failed, acknowledge })(exact);
    expect(first).toMatchObject({ ok: true, publishState: 'failed', ack: { status: 'accepted' } });
    expect(s.rows()).toHaveLength(0);
    s.advance();
    const retry = await createChannelReceiver({ ...s.options, acknowledge })(exact);
    expect(retry).toMatchObject({ ok: true, publishState: 'published', ack: { channel, status: 'duplicate' } });
    if (!first.ok || !retry.ok) throw new Error('expected receipts');
    expect(retry.ack.dedupeKey).toBe(first.ack.dedupeKey);
    expect(s.inboxCount()).toBe(1);
    const rows = s.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].envelope).toEqual(buildChannelBusEnvelope(first.envelope));
    expect(retry.envelope.receivedAt).not.toBe(first.envelope.receivedAt);
    expect(rows[0].envelope).toEqual(buildChannelBusEnvelope({ ...retry.envelope, receivedAt: first.envelope.receivedAt }));
    expect(appendBusInbox(buildChannelBusEnvelope(first.envelope), { root: s.options.busRoot })).toMatchObject({ status: 'duplicate' });
    expect(await createChannelReceiver(s.options)({ ...exact, channel: 'mobile' })).toMatchObject({ publishState: 'skipped' });
    expect(s.rows()).toEqual(rows);
    expect(acknowledge.mock.calls).toHaveLength(2);
  });

  it('replays safely when a timed-out publish completes late', async () => {
    const s = fixture();
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let late!: Promise<void>;
    const first = createChannelReceiver({ ...s.options, publishTimeoutMs: 25, publish: envelope => {
      late = gate.then(() => s.publish(envelope));
      started();
      return late;
    } })(message);
    await ready;
    await vi.advanceTimersByTimeAsync(25);
    expect(await first).toMatchObject({ ok: true, publishState: 'failed' });
    release();
    await late;
    const before = s.rows();
    s.advance();
    expect(await createChannelReceiver(s.options)(message)).toMatchObject({ publishState: 'published', ack: { channel: 'email', status: 'duplicate' } });
    expect(s.rows()).toEqual(before);
    expect(before).toHaveLength(1);
    expect(s.inboxCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('authenticates before storage, acknowledgement or repair', async () => {
    const s = fixture();
    const publish = vi.fn(s.publish), acknowledge = vi.fn(async () => {});
    const receive = createChannelReceiver({ ...s.options, publish, acknowledge });
    expect(await receive({ ...message, verifiedSenderId: 'fake-intruder' })).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(existsSync(s.options.runsDir)).toBe(false);
    await createChannelReceiver({ ...s.options, publish: async () => { throw new Error('fake'); } })(message);
    const before = readFileSync(s.receiptPath, 'utf8');
    expect(await receive({ ...message, verifiedSenderId: 'fake-intruder' })).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(readFileSync(s.receiptPath, 'utf8')).toBe(before);
    expect(publish).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(s.rows()).toHaveLength(0);
  });

  it('refuses to rebuild a body from case, whitespace, source, channel, thread or sender variants', async () => {
    const s = fixture();
    const options = { ...s.options, allowedSenderIds: new Set(['fake-mason', 'fake-other']) };
    const exact = { ...message, threadId: 'fake-thread-1' };
    await createChannelReceiver({ ...options, publish: async () => { throw new Error('fake outage'); } })(exact);
    const stored = readFileSync(s.receiptPath, 'utf8');
    expect(stored).toMatch(/envelopeDigest/);
    expect(stored).not.toContain('shared order');
    expect(stored).not.toContain('fake-mason');
    const variants = [
      { ...exact, body: exact.body.toUpperCase() },
      { ...exact, body: ' fake cafe\u0301\r\nshared order ' },
      { ...exact, body: 'fake café\nshared  order' },
      { ...exact, channel: 'telegram' as const },
      { ...exact, threadId: 'fake-thread-2' },
      { ...exact, threadId: undefined },
      { ...exact, canonicalSenderId: 'fake-mason', verifiedSenderId: 'fake-other' },
    ];
    for (const variant of variants) {
      s.advance();
      const publish = vi.fn(s.publish);
      const result = await createChannelReceiver({ ...options, publish })(variant);
      // Variants that normalize to the same dedupe hash are duplicates; others are new receipts.
      if (result.ok && result.ack.status === 'duplicate') {
        expect(result).toMatchObject({ publishState: 'failed' });
        expect(publish).not.toHaveBeenCalled();
        expect(s.rows()).toHaveLength(0);
      }
    }
    const pending = JSON.parse(readFileSync(s.receiptPath, 'utf8')).find((row: unknown[]) => row.length === 4);
    expect(pending[3]).toMatchObject({ channel: 'email', pending: true });
    const recovered = await createChannelReceiver(options)(exact);
    expect(recovered).toMatchObject({ publishState: 'published', ack: { status: 'duplicate' } });
    expect(s.rows()).toHaveLength(1);
  });

  it('fails closed on legacy receipts without a digest and strictly refuses malformed digests', async () => {
    const s = fixture();
    await createChannelReceiver({ ...s.options, publish: async () => { throw new Error('fake outage'); } })(message);
    const rows = JSON.parse(readFileSync(s.receiptPath, 'utf8'));
    const { envelopeDigest, ...legacyMirror } = rows[0][3];
    expect(envelopeDigest).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(s.receiptPath, JSON.stringify([[rows[0][0], rows[0][1], rows[0][2], legacyMirror]]));
    const acknowledge = vi.fn(async () => {});
    const publish = vi.fn(s.publish);
    expect(await createChannelReceiver({ ...s.options, publish, acknowledge })(message))
      .toMatchObject({ publishState: 'failed', ack: { status: 'duplicate' } });
    expect(publish).not.toHaveBeenCalled();
    expect(s.inboxCount()).toBe(1);
    expect(s.rows()).toHaveLength(0);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(s.receiptPath, 'utf8'))[0][3].pending).toBe(true);
    for (const bad of ['ABC', envelopeDigest.toUpperCase(), envelopeDigest.slice(1), 7, null]) {
      writeFileSync(s.receiptPath, JSON.stringify([[rows[0][0], rows[0][1], rows[0][2], { ...legacyMirror, envelopeDigest: bad }]]));
      s.advance();
      expect(await createChannelReceiver(s.options)(message)).toEqual({ ok: false, reason: 'dedupe-store-unavailable' });
    }
    writeFileSync(s.receiptPath, JSON.stringify([[rows[0][0], rows[0][1], rows[0][2], { ...legacyMirror, envelopeDigest, extra: 1 }]]));
    expect(await createChannelReceiver(s.options)(message)).toEqual({ ok: false, reason: 'dedupe-store-unavailable' });
    expect(s.rows()).toHaveLength(0);
  });

  it('bounds each persistent failure to one attempt and the existing deadline', async () => {
    const s = fixture();
    vi.useFakeTimers();
    const acknowledge = vi.fn(async () => {});
    let started!: () => void;
    const publish = vi.fn(() => { started(); return new Promise<void>(() => {}); });
    for (const status of ['accepted', 'duplicate']) {
      const ready = new Promise<void>(resolve => { started = resolve; });
      const result = createChannelReceiver({ ...s.options, publish, acknowledge, publishTimeoutMs: 30 })(message);
      await ready;
      await vi.advanceTimersByTimeAsync(30);
      expect(await result).toMatchObject({ ok: true, publishState: 'failed', ack: { status } });
    }
    expect(publish).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(s.inboxCount()).toBe(1);
    expect(s.rows()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('accepted tuple binds COS queue, bus and mirror recovery', () => {
    const queued = async (runsDir: string) => (await new QueueStore(join(runsDir, 'queue')).read()).jobs;
    // A regular file where the queue directory belongs makes the first queue write fail after the receipt committed.
    const breakQueue = (runsDir: string) => { mkdirSync(runsDir, { recursive: true }); writeFileSync(join(runsDir, 'queue'), 'fake-block'); };
    const exact = { ...message, threadId: 'fake-thread-1' };

    it.each(['mirror', 'no-mirror'] as const)('variants never enqueue or publish after a failed queue write (%s)', async (mode) => {
      const s = fixture();
      const options = { ...s.options, allowedSenderIds: new Set(['fake-mason', 'fake-other']), ...(mode === 'no-mirror' ? { publish: null } : {}) };
      breakQueue(s.options.runsDir);
      expect(await createChannelReceiver(options)(exact)).toEqual({ ok: false, reason: 'write-failed' });
      const stored = readFileSync(s.receiptPath, 'utf8');
      expect(stored).toMatch(/envelopeDigest/);
      expect(stored).not.toContain('shared order');
      expect(stored).not.toContain('fake-mason');
      rmSync(join(s.options.runsDir, 'queue'));
      const variants = [
        { ...exact, body: exact.body.toUpperCase() },
        { ...exact, body: ' fake cafe\u0301\r\nshared order ' },
        { ...exact, body: 'fake café\nshared  order' },
        { ...exact, channel: 'telegram' as const },
        { ...exact, threadId: 'fake-thread-2' },
        { ...exact, threadId: undefined },
        { ...exact, canonicalSenderId: 'fake-mason', verifiedSenderId: 'fake-other' },
      ];
      for (const variant of variants) {
        s.advance();
        const publish = vi.fn(s.publish);
        const result = await createChannelReceiver({ ...options, ...(mode === 'mirror' ? { publish } : {}) })(variant);
        expect(result).toMatchObject({ ok: true, ack: { status: 'duplicate' } });
        expect(publish).not.toHaveBeenCalled();
        expect(await queued(s.options.runsDir)).toHaveLength(0);
        expect(s.rows()).toHaveLength(0);
      }
      s.advance();
      const first = JSON.parse(stored)[0];
      const retry = await createChannelReceiver(options)(exact);
      expect(retry).toMatchObject({ ok: true, ack: { status: 'duplicate' }, publishState: mode === 'mirror' ? 'published' : 'skipped' });
      const jobs = await queued(s.options.runsDir);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].scope).toBe(exact.body);
      expect(JSON.parse(jobs[0].acceptance)).toEqual({ kind: 'cos-intake', origin: { channel: 'email', senderId: 'fake-mason', threadId: 'fake-thread-1' } });
      expect(s.rows()).toHaveLength(mode === 'mirror' ? 1 : 0);
      if (mode === 'mirror') expect(s.rows()[0].envelope).toEqual(buildChannelBusEnvelope({ ...(retry as { envelope: ChannelEnvelope }).envelope, receivedAt: new Date(first[1]).toISOString() }));
      expect(JSON.parse(readFileSync(s.receiptPath, 'utf8'))[0][3]).toMatchObject({ pending: false, envelopeDigest: first[3].envelopeDigest });
    });

    it('records the binding with mirroring disabled and background queueing on', async () => {
      const s = fixture();
      expect(await createChannelReceiver({ ...s.options, publish: null })(exact)).toMatchObject({ ok: true, publishState: 'skipped' });
      const mirror = JSON.parse(readFileSync(s.receiptPath, 'utf8'))[0][3];
      expect(mirror).toEqual({ channel: 'email', pending: false, envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    });

    it('legacy receipts without a digest never recreate the queue or bus effect', async () => {
      const s = fixture();
      breakQueue(s.options.runsDir);
      await createChannelReceiver(s.options)(exact);
      rmSync(join(s.options.runsDir, 'queue'));
      const rows = JSON.parse(readFileSync(s.receiptPath, 'utf8'));
      const { envelopeDigest: _drop, ...legacy } = rows[0][3];
      writeFileSync(s.receiptPath, JSON.stringify([[rows[0][0], rows[0][1], rows[0][2], legacy]]));
      const publish = vi.fn(s.publish);
      s.advance();
      expect(await createChannelReceiver({ ...s.options, publish })(exact)).toMatchObject({ ok: true, publishState: 'failed', ack: { status: 'duplicate' } });
      expect(publish).not.toHaveBeenCalled();
      expect(await queued(s.options.runsDir)).toHaveLength(0);
      expect(s.rows()).toHaveLength(0);
    });

    it('fails closed when receipt channel disagrees with the hash-proven channel', async () => {
      const s = fixture();
      breakQueue(s.options.runsDir);
      await createChannelReceiver(s.options)(exact);
      rmSync(join(s.options.runsDir, 'queue'));
      const rows = JSON.parse(readFileSync(s.receiptPath, 'utf8'));
      writeFileSync(s.receiptPath, JSON.stringify([[rows[0][0], rows[0][1], rows[0][2], { ...rows[0][3], channel: 'telegram' }]]));
      const publish = vi.fn(s.publish);
      s.advance();
      expect(await createChannelReceiver({ ...s.options, publish })(exact)).toMatchObject({ ok: true, publishState: 'failed', ack: { status: 'duplicate' } });
      expect(publish).not.toHaveBeenCalled();
      expect(await queued(s.options.runsDir)).toHaveLength(0);
      expect(s.rows()).toHaveLength(0);
    });
  });
});
