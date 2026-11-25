import { afterEach, expect, it, vi } from 'vitest';
import { createSlackNoticeHealth } from '../src/cli/slack-notice-health.js';
import type { ClaimNoticeTickOutcome } from '../src/cli/channels-slack-claim-tick.js';
import { cmdChannelsSlack } from '../src/cli/channels-slack.js';

const mocks = vi.hoisted(() => ({ tick: vi.fn(), flush: vi.fn() }));
vi.mock('../src/cli/channels-slack-claim-tick.js', () => ({ createClaimNoticeTick: () => ({ maybeRun: mocks.tick }) }));
vi.mock('../src/core/agents/slack-network.js', () => ({
  loadAgentNetworkConfig: () => ({ state: 'ok', slack: { map: [], teamId: 'test' }, teamIdentities: [] }),
  loadCommsConfirmation: () => false,
}));
vi.mock('../src/core/agents/slack-credentials.js', () => ({ injectedSlackCredentialResolver: () => () => undefined }));
vi.mock('../src/core/agents/slack-transport.js', () => ({
  createSlackApi: () => vi.fn(), verifySlackIdentity: vi.fn(), deliverSlackEnvelope: vi.fn(),
  openSlackSocket: () => ({ addEventListener: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/core/agents/slack-leader.js', () => ({
  createSlackLeaderAdapter: vi.fn(), flushSlackLeaderReplies: mocks.flush, readSlackDeliveryPolicy: vi.fn(),
}));
vi.mock('../src/core/fleet/bus-inbox.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/bus-inbox.js')>(),
  listBusInboxAfter: () => ({ status: 'ok', messages: [] }),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocks.tick.mockReset(); mocks.flush.mockReset(); });
const completed = { ran: true, sent: 0, deduped: 0, failed: 0 } as const;
const blocked = (status: 'board-unavailable' | 'ledger-unavailable' | 'bindings-unavailable' | 'prev-unavailable'): ClaimNoticeTickOutcome =>
  ({ ...completed, status, reason: 'untrusted text' });

it.each([
  ['board-unavailable', 'board-state-unknown'], ['ledger-unavailable', 'sent-ledger-unreadable'],
  ['bindings-unavailable', 'claim-bindings-unreadable'], ['prev-unavailable', 'prev-snapshot-unreadable'],
] as const)('retains fixed %s evidence through a skip and recovery', (status, reason) => {
  const h = createSlackNoticeHealth();
  h.observe(blocked(status), 'first');
  h.observe({ ran: false, reason: 'interval' }, 'second');
  expect(h.health).toMatchObject({ status, reason, lastAttemptAt: 'first', lastTick: 'interval', blocked: 1, recovery: 'blocked' });
  h.observe(completed, 'third');
  expect(h.health).toMatchObject({ status: 'completed', reason: null, lastAttemptAt: 'third', blocked: 1, recovery: 'recovered' });
});

it('distinguishes missing, in-flight, errors, kill, abort and dry run', () => {
  const h = createSlackNoticeHealth();
  expect(h.health).toMatchObject({ status: 'unknown', recovery: 'unknown', lastAttemptAt: null });
  h.observe({ ran: false, reason: 'in-flight' }, 'a');
  expect(h.health).toMatchObject({ status: 'unknown', lastTick: 'in-flight', lastAttemptAt: null });
  h.observe({ ran: false, reason: 'pass-error' }, 'b');
  expect(h.health).toMatchObject({ status: 'pass-error', passErrors: 1, recovery: 'blocked' });
  for (const reason of ['kill-switch', 'aborted'] as const) {
    h.observe({ ran: false, reason }, 'c');
    expect(h.health).toMatchObject({ status: reason, reason, recovery: 'unknown', passErrors: 1 });
  }
  h.observe({ ...completed, status: 'dry-run' }, 'd');
  expect(h.health).toMatchObject({ status: 'dry-run', recovery: 'unknown' });
  h.observe(completed, 'e');
  expect(h.health.recovery).toBe('recovered');
});

it.each(['normal', 'bounded-stop'] as const)('includes the real aggregate in %s session JSON', async mode => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.tick.mockResolvedValueOnce(blocked('ledger-unavailable')).mockResolvedValue({ ran: false, reason: 'interval' });
  mocks.flush.mockResolvedValue({ state: 'completed', sent: 0 });
  if (mode === 'bounded-stop') mocks.flush.mockImplementationOnce(async () => ({ state: 'completed', sent: 0 }))
    .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('private')), { once: true });
    }));
  const result = cmdChannelsSlack(['run', '--seconds', '2', '--json']);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toBe(0);
  const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(output).toMatchObject({ ok: true, mode: 'socket-session', claimNotices: {
    passes: 1, health: { status: 'ledger-unavailable', reason: 'sent-ledger-unreadable', blocked: 1, recovery: 'blocked', lastAttemptAt: '2026-01-01T00:00:00.000Z' },
  } });
  if (mode === 'bounded-stop') expect(output.stopped).toBe('bounded-stop');
  else expect(output.stopped).toBeUndefined();
});
