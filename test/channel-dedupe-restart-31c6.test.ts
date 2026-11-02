import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_DEDUPE_WINDOW_MS, createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import type { InboxAppendResult } from '../src/core/fleet/mason-inbox.js';
import { createLocalChannelDedupeStore } from '../src/core/fleet/channel-dedupe-store.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const message = { channel: 'email' as const, verifiedSenderId: 'fake-alice', body: ' cafe\u0301\r\nhello ' };
function setup() {
  const runsDir = mkdtempSync(join(tmpdir(), 'channel-31c6-'));
  directories.push(runsDir);
  let time = Date.parse('2026-10-31T00:13:00Z');
  const write = vi.fn(async (): Promise<InboxAppendResult> => ({ ok: true, at: 'fake-time', bytes: 1 }));
  const acknowledge = vi.fn(async () => {});
  const options = { runsDir, write, acknowledge, now: () => new Date(time), allowedSenderIds: new Set(['fake-alice', 'fake-bob']) };
  return { runsDir, write, acknowledge, options, receiver: () => createChannelReceiver(options), advance: (ms: number) => { time += ms; } };
}

describe('channel receipts across receiver restarts (31c6)', () => {
  it('shares normalized cross-channel receipts after restart without storing plaintext', async () => {
    const s = setup();
    const first = await s.receiver()(message);
    const retry = await s.receiver()({ ...message, channel: 'telegram', body: 'café\nhello' });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(retry.ok && retry.ack).toEqual({ channel: 'telegram', status: 'duplicate', dedupeKey: first.ok && first.ack.dedupeKey });
    expect(s.write).toHaveBeenCalledTimes(1);
    expect(s.acknowledge).toHaveBeenCalledTimes(2);
    const rows = JSON.parse(readFileSync(join(s.runsDir, 'channel-receipts', 'receipts.json'), 'utf8'));
    expect(rows).toEqual([[expect.stringMatching(/^[a-f0-9]{64}$/), s.options.now().getTime(), first.ok && first.ack.dedupeKey]]);
  });

  it('serializes two receivers while persistence is pending', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.write.mockImplementationOnce(async () => { await gate; return { ok: true, at: 'fake-time', bytes: 1 }; });
    const first = s.receiver()(message);
    const second = s.receiver()({ ...message, channel: 'cli' });
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.ok && r.ack.status).sort()).toEqual(['accepted', 'duplicate']);
    expect(s.write).toHaveBeenCalledTimes(1);
  });

  it('keeps senders distinct and expires from the original receipt, not the last retry', async () => {
    const s = setup();
    await s.receiver()(message);
    await s.receiver()({ ...message, verifiedSenderId: 'fake-bob' });
    s.advance(CHANNEL_DEDUPE_WINDOW_MS - 1);
    expect((await s.receiver()(message)).ok).toBe(true);
    expect(s.write).toHaveBeenCalledTimes(2);
    s.advance(1);
    const expired = await s.receiver()(message);
    expect(expired.ok && expired.ack.status).toBe('accepted');
    expect(s.write).toHaveBeenCalledTimes(3);
  });

  it('retries refused and throwing appends without acknowledgements or receipts', async () => {
    const s = setup();
    s.write.mockResolvedValueOnce({ ok: false, reason: 'write-failed' });
    s.write.mockRejectedValueOnce(new Error('fake failure'));
    expect(await s.receiver()(message)).toEqual({ ok: false, reason: 'write-failed' });
    expect(await s.receiver()(message)).toEqual({ ok: false, reason: 'write-failed' });
    expect(s.acknowledge).not.toHaveBeenCalled();
    const retry = await s.receiver()(message);
    expect(retry.ok && retry.ack.status).toBe('accepted');
  });

  it('fails explicitly on corrupt receipts before appending or acknowledging', async () => {
    const s = setup();
    await s.receiver()(message);
    writeFileSync(join(s.runsDir, 'channel-receipts', 'receipts.json'), '{broken');
    s.acknowledge.mockClear();
    expect(await s.receiver()(message)).toEqual({ ok: false, reason: 'dedupe-store-unavailable' });
    expect(s.write).toHaveBeenCalledTimes(1);
    expect(s.acknowledge).not.toHaveBeenCalled();
  });

  it('refuses capacity without evicting live receipts and accepts after expiry', async () => {
    const s = setup();
    await s.receiver()(message);
    const path = join(s.runsDir, 'channel-receipts', 'receipts.json');
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    for (let i = 1; i < 10_000; i++) {
      const hash = createHash('sha256').update(`fake-${i}`).digest('hex');
      rows.push([hash, s.options.now().getTime(), hash]);
    }
    writeFileSync(path, JSON.stringify(rows));
    expect(await s.receiver()({ ...message, body: 'new body' })).toEqual({ ok: false, reason: 'full' });
    const duplicate = await s.receiver()(message);
    expect(duplicate.ok && duplicate.ack.status).toBe('duplicate');
    s.advance(CHANNEL_DEDUPE_WINDOW_MS);
    expect((await s.receiver()({ ...message, body: 'new body' })).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
  });

  it('reports receipt commit failure without acknowledging the already persisted append', async () => {
    const s = setup();
    const receive = createChannelReceiver({ ...s.options, receiptStore: {
      transaction: async (work) => work(new Map(), () => { throw new Error('fake receipt failure'); }),
    } });
    expect(await receive(message)).toEqual({ ok: false, reason: 'dedupe-store-unavailable' });
    expect(s.write).toHaveBeenCalledTimes(1);
    expect(s.acknowledge).not.toHaveBeenCalled();
    // No durable receipt exists: a retry may append again in this documented gap.
    expect(await receive(message)).toEqual({ ok: false, reason: 'dedupe-store-unavailable' });
    expect(s.write).toHaveBeenCalledTimes(2);
  });

  it('uses the default inbox store and supports an explicitly injected store', async () => {
    const s = setup();
    const { write: _write, ...options } = s.options;
    expect((await createChannelReceiver(options)(message)).ok).toBe(true);
    const retry = await createChannelReceiver(options)(message);
    expect(retry.ok && retry.ack.status).toBe('duplicate');
    const inbox = readFileSync(join(s.runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox.match(/^## /gm)).toHaveLength(1);
    const receive = createChannelReceiver({ ...s.options, runsDir: undefined, receiptStore: createLocalChannelDedupeStore(s.runsDir) });
    expect((await receive(message)).ok).toBe(true);
    expect(s.write).not.toHaveBeenCalled();
  });
});
