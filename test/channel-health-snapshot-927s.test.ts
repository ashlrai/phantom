import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const readers = vi.hoisted(() => ({ journal: vi.fn(), sends: vi.fn() }));
vi.mock('../src/core/agents/slack-journal.js', () => ({ readSlackJournal: readers.journal }));
vi.mock('../src/core/agents/slack-send-receipts.js', () => ({ readSlackSendReceipts: readers.sends }));
vi.mock('../src/core/agents/slack-network.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/agents/slack-network.js')>(),
  loadAgentNetworkConfig: () => ({ state: 'ok', slack: { botTokenRef: 'ref', appTokenRef: 'ref', map: [{}] } }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: (_command: unknown, _args: unknown, _options: unknown, callback: (err: null) => void) => callback(null),
}));

import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const at = '2026-11-13T17:30:00.000Z';
const id = fakeRequestId('snapshot-927');
const request = { at, decision: 'ingested', channelId: 'C0FAKELEADER', messageTs: '1700000000.000100',
  threadTs: '1700000000.000100', bus: 'posted', requestId: id };
const sent = { key: replyKey(id), channel: 'C0FAKELEADER', thread: '1700000000.000100', state: 'sent', ts: '1700000000.000200' };
const imessage: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
const report = async () => (await readChannelHealth({ now: () => now, host: 'test', sources: { imessage } })).channels[0]!;

beforeEach(() => { readers.journal.mockReset(); readers.sends.mockReset(); });

describe('default Slack health snapshot', () => {
  it('uses one generation per report and refreshes on the next report', async () => {
    readers.journal.mockReturnValueOnce({ state: 'ok', entries: [] }).mockReturnValue({ state: 'ok', entries: [request] });
    readers.sends.mockReturnValueOnce({ state: 'ok', receipts: [] }).mockReturnValue({ state: 'ok', receipts: [sent] });
    const first = await report();
    expect(readers.journal).toHaveBeenCalledTimes(1);
    expect(readers.sends).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
      proof: { requestCoverage: 'idle', answeredCount: 0, durableIngress: { posted: 0 } } });
    const second = await report();
    expect(readers.journal).toHaveBeenCalledTimes(2);
    expect(readers.sends).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ lastInboundAt: at, lastReplyAt: '2023-11-14T22:13:20.000Z', unansweredCount: 0,
      proof: { requestCoverage: 'verified', answeredCount: 1, durableIngress: { posted: 1 } } });
  });

  it.each(['missing', 'degraded'] as const)('never verifies with %s send evidence', async (state) => {
    readers.journal.mockReturnValue({ state: 'ok', entries: [request] });
    readers.sends.mockReturnValueOnce({ state, receipts: [] }).mockReturnValue({ state: 'ok', receipts: [sent] });
    const result = await report();
    expect(readers.sends).toHaveBeenCalledTimes(1);
    expect(result.proof.requestCoverage).not.toBe('verified');
    if (state === 'missing') expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: 1 });
    else expect(result).toMatchObject({ state: 'UNKNOWN', missing: ['slack receipt source unreadable'] });
  });
});
