import { afterEach, expect, it, vi } from 'vitest';
import { cmdChannelsSlack } from '../src/cli/channels-slack.js';

const mocks = vi.hoisted(() => ({ pass: vi.fn(), inbox: vi.fn(), deliver: vi.fn(), flush: vi.fn() }));
vi.mock('../src/cli/channels-slack-claim-tick.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/cli/channels-slack-claim-tick.js')>();
  return { ...actual, createClaimNoticeTick: () => actual.createClaimNoticeTick({ pass: mocks.pass, killed: () => false }) };
});
vi.mock('../src/core/agents/slack-network.js', () => ({
  loadAgentNetworkConfig: () => ({ state: 'ok', slack: { bridgeId: 'fake-bridge', teamId: 'T000FAKE',
    map: [{ topic: 'fake-topic', channel: 'C000FAKE' }] }, teamIdentities: [] }),
  loadCommsConfirmation: () => false,
}));
vi.mock('../src/core/agents/slack-credentials.js', () => ({ injectedSlackCredentialResolver: () => () => undefined }));
vi.mock('../src/core/agents/slack-transport.js', () => ({
  createSlackApi: () => vi.fn(), verifySlackIdentity: vi.fn(), deliverSlackEnvelope: mocks.deliver,
  openSlackSocket: () => ({ addEventListener: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/core/agents/slack-leader.js', () => ({
  createSlackLeaderAdapter: vi.fn(), flushSlackLeaderReplies: mocks.flush, readSlackDeliveryPolicy: vi.fn(),
}));
vi.mock('../src/core/fleet/bus-inbox.js', () => ({ listBusInboxAfter: mocks.inbox }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); Object.values(mocks).forEach(mock => mock.mockReset()); });

it.each(['refused', 'uncertain', 'sent', 'stop-before-delivery'] as const)(
  'emits enqueue-only evidence independently of transport: %s', async status => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const envelope = { id: 'fake-notice', to: 'fake-topic', channel: 'slack',
      channel_ref: 'T000FAKE/C000FAKE/1700000000.000001', ttl: 60_000,
      body: { kind: 'note', inReplyTo: 'fake-dedupe' } };
    let messages: unknown[] = [];
    mocks.flush.mockResolvedValue({ state: 'completed', sent: 0 });
    mocks.pass.mockImplementation(async () => {
      messages = [{ cursor: 1, receivedAt: Date.now(), envelope }];
      // This synthetic boundary models the durable enqueue result, not Slack.
      const result = { status: 'completed', sent: 1, skipped: 0, failed: 0,
        deliveries: [{ receipt: 'bus-note:fake-notice' }] };
      return result;
    });
    mocks.inbox.mockImplementation((cursor: number) => {
      if (status === 'stop-before-delivery') vi.advanceTimersByTime(4000);
      return { status: 'ok', messages: cursor ? [] : messages };
    });
    mocks.deliver.mockResolvedValue({ status, reason: status === 'sent' ? 'delivery-proved' : 'synthetic-failure',
      ...(status === 'sent' ? { ts: '1700000000.000002' } : {}) });
    const running = cmdChannelsSlack(['run', '--seconds', '4', '--json']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await running).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    const counts = { sent: Number(status === 'sent'), refused: Number(status === 'refused'),
      uncertain: Number(status === 'uncertain'), duplicate: 0 };
    expect(output).toMatchObject({ ok: true, ...counts,
      transport: { scope: 'all-session-slack-messages', ...counts },
      claimNotices: { passes: 1, sent: 1, failed: 0, skipped: 0,
        stage: 'durable-bus-enqueue', receiptKind: 'bus-note', sentMeaning: 'enqueued',
        skippedMeaning: 'enqueue-ledger-deduped', slackDelivery: 'unverified', health: {
          stage: 'durable-bus-enqueue', receiptKind: 'bus-note', slackDelivery: 'unverified',
          status: 'completed', recovery: 'healthy', lastAttemptAt: '2026-01-01T00:00:00.000Z',
        } },
    });
    expect(mocks.deliver).toHaveBeenCalledTimes(status === 'stop-before-delivery' ? 0 : 1);
    if (status !== 'stop-before-delivery') expect(mocks.deliver.mock.calls[0]?.[0]).toBe(envelope);
    expect(output.claimNotices.receipts).toBeUndefined();
    expect(output.claimNotices.health.lastTick).toBe(status === 'stop-before-delivery' ? 'completed' : 'interval');
    expect(mocks.pass).toHaveBeenCalledTimes(1);
  },
);
