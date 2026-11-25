import { describe, expect, it, vi } from 'vitest';

const readers = vi.hoisted(() => ({ journal: vi.fn(), sends: vi.fn() }));
vi.mock('../src/core/agents/slack-journal.js', () => ({ readSlackJournal: readers.journal }));
vi.mock('../src/core/agents/slack-send-receipts.js', () => ({ readSlackSendReceipts: readers.sends }));
import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const sentinel = 'FAKE_PRIVATE_PAYLOAD_946';
const attempted = { key: 'fake-key-946', channel: 'CFAKE946', thread: '1700000000.000100', state: 'attempted', payload: sentinel };
const sent = { ...attempted, key: 'fake-sent-key-946', state: 'sent', ts: '1700000000.000200' };
const other: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };

async function report(receipts: object[], entries: object[] = []) {
  readers.journal.mockReturnValue({ state: 'ok', entries });
  readers.sends.mockReturnValue({ state: 'ok', receipts });
  const slack = { ...defaultChannelSources('/fake-runs').slack, configMissing: () => [], processAlive: () => true };
  const result = await readChannelHealth({ now: () => now, host: 'fake-host', sources: { slack, imessage: other } });
  const serialized = JSON.stringify(result);
  for (const secret of [sentinel, attempted.key, sent.key, attempted.channel, attempted.thread, 'payload']) {
    expect(serialized).not.toContain(secret);
  }
  return result.channels[0]!;
}

describe('Slack outbound attempt health', () => {
  it('reports unknown for an idle unresolved attempt', async () => {
    expect(await report([attempted])).toMatchObject({ state: 'UNKNOWN', lastReplyAt: null, proof: { requestCoverage: 'idle' } });
  });
  it('cannot certify mixed attempted and sent receipts', async () => {
    const result = await report([attempted, sent]);
    expect(result.state).toBe('UNKNOWN');
    expect(result.proof.requestCoverage).not.toBe('verified');
  });
  it('retains sent activity for a sent-only store', async () => {
    expect(await report([sent])).toMatchObject({ state: 'LIVE', lastReplyAt: '2023-11-14T22:13:20.000Z' });
  });
  it('retains idle health for an empty store', async () => {
    expect(await report([])).toMatchObject({ state: 'LIVE', lastReplyAt: null, proof: { requestCoverage: 'idle' } });
  });
  it('preserves positive durable ingress failure precedence', async () => {
    const entries = [{ at: '2026-11-13T17:59:00.000Z', decision: 'ingested', bus: 'failed' }];
    expect(await report([attempted], entries)).toMatchObject({ state: 'DEGRADED', missing: expect.arrayContaining(['slack durable ingress failed']) });
  });
});
