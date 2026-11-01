import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannelReceiver, type ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';
import { publishChannelEnvelope, buildChannelBusEnvelope } from '../src/core/fleet/channel-bus-publish.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

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
  const rows = () => existsSync(busPath) ? JSON.parse(readFileSync(busPath, 'utf8')) : [];
  const inboxCount = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8').match(/^## /gm)?.length;
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
  it.each(['email', 'telegram'] as const)('recovers after restart through %s with original source and exact replay', async (channel) => {
    const s = fixture();
    const acknowledge = vi.fn(async () => {});
    const failed = vi.fn(async () => { throw new Error('fake initial outage'); });
    const first = await createChannelReceiver({ ...s.options, publish: failed, acknowledge })(message);
    expect(first).toMatchObject({ ok: true, publishState: 'failed', ack: { status: 'accepted' } });
    expect(s.rows()).toHaveLength(0);
    s.advance();
    const retry = await createChannelReceiver({ ...s.options, acknowledge })({ ...message, channel, body: ' fake cafe\u0301\r\nshared order ' });
    expect(retry).toMatchObject({ ok: true, publishState: 'published', ack: { channel, status: 'duplicate' } });
    if (!first.ok || !retry.ok) throw new Error('expected receipts');
    expect(retry.ack.dedupeKey).toBe(first.ack.dedupeKey);
    expect(s.inboxCount()).toBe(1);
    const rows = s.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].envelope).toEqual(buildChannelBusEnvelope(first.envelope));
    expect(appendBusInbox(buildChannelBusEnvelope(first.envelope), { root: s.options.busRoot })).toMatchObject({ status: 'duplicate' });
    expect(await createChannelReceiver(s.options)({ ...message, channel: 'mobile' })).toMatchObject({ publishState: 'skipped' });
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
    expect(await createChannelReceiver(s.options)({ ...message, channel: 'desktop' })).toMatchObject({ publishState: 'published', ack: { channel: 'desktop', status: 'duplicate' } });
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

  it('reads legacy receipts but skips repair when original source is unknown', async () => {
    const s = fixture();
    await createChannelReceiver({ ...s.options, publish: null })(message);
    const rows = JSON.parse(readFileSync(s.receiptPath, 'utf8'));
    writeFileSync(s.receiptPath, JSON.stringify(rows.map((row: unknown[]) => row.slice(0, 3))));
    const acknowledge = vi.fn(async () => {});
    expect(await createChannelReceiver({ ...s.options, acknowledge })({ ...message, channel: 'cli' })).toMatchObject({ publishState: 'skipped', ack: { status: 'duplicate', channel: 'cli' } });
    expect(s.inboxCount()).toBe(1);
    expect(s.rows()).toHaveLength(0);
    expect(acknowledge).toHaveBeenCalledTimes(1);
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
});
