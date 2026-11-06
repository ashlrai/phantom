import { describe, expect, it, vi } from 'vitest';
import { createChannelHost, runInMemoryDemo, type ChannelPort } from '../examples/channel-host.js';
import type { ChannelAck, ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

const now = () => new Date('2026-01-01T00:00:00Z');
const success = { ok: true as const, at: 'fake-time', bytes: 1 };

function setup() {
  const writes: ChannelEnvelope[] = [];
  const acks: Record<string, ChannelAck[]> = { desktop: [], telegram: [], email: [] };
  const port = (channel: string): ChannelPort => ({
    verifyIdentity: vi.fn(async (evidence) => evidence === 'verified' ? 'canonical-mason' : null),
    acknowledge: vi.fn(async (ack) => { acks[channel].push(ack); }),
  });
  const ports = { desktop: port('desktop'), telegram: port('telegram'), email: port('email') };
  const write = vi.fn(async (entry: ChannelEnvelope) => { writes.push(entry); return success; });
  const host = createChannelHost({ ports, write, now, allowedSenderIds: new Set(['canonical-mason']) });
  return { host, ports, writes, acks, write };
}

describe('channel host example', () => {
  it('shares one receiver and routes accepted and duplicate acknowledgments to their sources', async () => {
    const { host, writes, acks } = setup();
    const first = await host.desktop({ evidence: 'verified', body: ' Hello\r\nworld ' });
    const second = await host.telegram({ evidence: 'verified', body: 'Hello\nworld' });
    expect(first.ok && first.acknowledgement).toBe('sent');
    expect(second.ok && second.acknowledgement).toBe('sent');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ channel: 'desktop', verifiedSenderId: 'canonical-mason', body: 'Hello\nworld' });
    expect(acks.desktop).toEqual([{ channel: 'desktop', status: 'accepted', dedupeKey: writes[0].dedupeKey }]);
    expect(acks.telegram).toEqual([{ channel: 'telegram', status: 'duplicate', dedupeKey: writes[0].dedupeKey }]);
    expect(acks.email).toEqual([]);
  });

  it('requires verified identity and ignores forged payload channel and identity', async () => {
    const { host, writes, acks, ports } = setup();
    const forged = { evidence: 'unverified', body: 'hello', channel: 'desktop', verifiedSenderId: 'canonical-mason' };
    expect(await host.email(forged)).toEqual({ ok: false, reason: 'unverified' });
    expect(writes).toEqual([]);
    expect(acks.email).toEqual([]);
    expect(ports.email.verifyIdentity).toHaveBeenCalledWith('unverified');
    const result = await host.email({ ...forged, evidence: 'verified', channel: 'telegram', verifiedSenderId: 'impostor' });
    expect(result.ok).toBe(true);
    expect(writes[0]).toMatchObject({ channel: 'email', verifiedSenderId: 'canonical-mason' });
    expect(acks.email[0]).toMatchObject({ channel: 'email', status: 'accepted' });
    expect(acks.desktop).toEqual([]);
    expect(acks.telegram).toEqual([]);
  });

  it('reports authentication and receiver failures without acknowledging, and retries failed writes', async () => {
    const { ports } = setup();
    const write = vi.fn().mockRejectedValueOnce(new Error('fake sink failure')).mockResolvedValue(success);
    const host = createChannelHost({ ports, write, now, allowedSenderIds: new Set(['canonical-mason']) });
    vi.mocked(ports.email.verifyIdentity).mockRejectedValueOnce(new Error('fake auth failure'));
    expect(await host.email({ evidence: 'verified', body: 'hello' })).toEqual({ ok: false, reason: 'authentication-failed' });
    expect(await host.email({ evidence: 'verified', body: 'hello' })).toEqual({ ok: false, reason: 'write-failed' });
    expect(ports.email.acknowledge).not.toHaveBeenCalled();
    const retry = await host.email({ evidence: 'verified', body: 'hello' });
    expect(retry.ok && retry.receipt.ack.status).toBe('accepted');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports transport failure separately while retaining the successful receipt', async () => {
    const { host, ports, write } = setup();
    vi.mocked(ports.email.acknowledge).mockRejectedValueOnce(new Error('fake delivery failure'));
    const first = await host.email({ evidence: 'verified', body: 'hello' });
    expect(first.ok && [first.receipt.ack.status, first.acknowledgement]).toEqual(['accepted', 'failed']);
    const retry = await host.telegram({ evidence: 'verified', body: 'hello' });
    expect(retry.ok && [retry.receipt.ack.status, retry.acknowledgement]).toEqual(['duplicate', 'sent']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(ports.email.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }), 'verified');
  });

  it('runs the self-contained demonstration with only in-memory ports', async () => {
    const demo = await runInMemoryDemo();
    expect(demo.entries).toHaveLength(1);
    expect(demo.acknowledgements.map(({ channel, status }) => [channel, status])).toEqual([
      ['desktop', 'accepted'], ['telegram', 'duplicate'],
    ]);
  });
});
