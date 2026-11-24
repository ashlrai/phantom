import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig, SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { createSlackApi, deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('preserves a rate-limited assigned notice through restart and reconciles exactly once', async () => {
  vi.useFakeTimers();
  let now = Date.parse('2026-11-17T00:00:00Z');
  vi.setSystemTime(now);
  const dir = mkdtempSync(join(tmpdir(), 'slack-rate-limit-578s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs');
  const busRoot = join(dir, 'bus'), stateRoot = join(dir, 'transport');
  const paths = claimNoticePaths(runsRoot);
  const teamId = 'T000FAKE', channel = 'C000FAKE', thread = '1700000000.000001';
  const threadKey = `${teamId}/${channel}/${thread}`;
  const config: SlackBridgeConfig = { bridgeId: 'slack', teamId, ownUserId: 'U000BOT', ownBotId: 'B000BOT',
    botTokenRef: 'phm_fake', map: [{ topic: 'fake-topic', channel }] };
  const teamIdentities = [{ channel: 'slack' as const, id: 'U000OWNER' }];
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, now: () => now,
    readBoard: () => readFleetBoard({ path: ledger, now }) }));
  const advance = () => { now += 1_000; vi.setSystemTime(now); return { path: ledger, now }; };
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, advance()));
  expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
  const claim = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task', agent: 'fake-agent' }, advance())).claim;
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey,
    pr: 7, head: 'abcdef1234567' }, now).ok).toBe(true);
  const notice = await pass();
  expect(notice).toMatchObject({ planned: 1, sent: 1, failed: 0 });
  const inbox = scanBusInbox({ root: busRoot, now: () => now });
  expect(inbox.rows).toHaveLength(1);
  const envelope = inbox.rows[0]!.envelope;
  expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey, body: { kind: 'note' } });
  expect(JSON.stringify(envelope.body)).toContain('ASSIGNED');
  expect(JSON.stringify(envelope.body)).not.toContain('VERIFIED');
  expect(notice.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
  expect(readSlackSendReceipts({ stateRoot }).receipts).toEqual([]);
  const before = readFleetBoard({ path: ledger, now });
  let clientId = '', posts = 0;
  const adapter = createSlackApi({ config, resolveCredential: () => 'fake-token',
    fetch: async () => new Response(null, { status: 429 }) });
  const makeCall = (history: () => Record<string, unknown>): SlackCall => async (method, input = {}) => {
    if (method === 'auth.test') return { team_id: teamId, user_id: 'U000BOT', bot_id: 'B000BOT' };
    if (method === 'conversations.info') return { channel: { id: input.channel, is_channel: true, context_team_id: teamId } };
    if (method === 'conversations.members') return { members: ['U000BOT', 'U000OWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: input.user, team_id: teamId, ...(input.user === 'U000BOT' ? { is_bot: true } : {}) } };
    if (method === 'chat.postMessage') {
      posts++; clientId = String(input.client_msg_id);
      expect(input).toMatchObject({ channel, thread_ts: thread });
      expect(readSlackSendReceipts({ stateRoot }).receipts).toMatchObject([{ state: 'attempted', channel, thread }]);
      return adapter(method, input);
    }
    if (method === 'conversations.replies') {
      expect(input).toMatchObject({ channel, ts: thread });
      return history();
    }
    throw new Error(`unexpected method ${method}`);
  };
  const deliver = (call: SlackCall) => deliverSlackEnvelope(envelope, { config, teamIdentities, confirmedByMason: true,
    stateRoot, runsDir: runsRoot, busRoot, call });
  expect(await deliver(makeCall(() => ({ messages: [] })))).toEqual({ status: 'uncertain', reason: 'transport-or-storage-unavailable' });
  expect(clientId).toBeTruthy();
  expect(inbox.rows[0]!.envelope).toEqual(envelope);
  const key = slackSendStoreKey(envelope.id);
  expect(readSlackSendReceipts({ stateRoot })).toMatchObject({ state: 'ok', receipts: [{ key, state: 'attempted', channel, thread }] });
  advance();
  expect(await deliver(makeCall(() => ({ messages: [], has_more: false, response_metadata: { next_cursor: '' } })))).toEqual({ status: 'uncertain', reason: 'delivery-needs-reconciliation' });
  expect(posts).toBe(1);
  expect(readSlackSendReceipts({ stateRoot }).receipts).toMatchObject([{ key, state: 'attempted' }]);
  advance();
  const ts = '1700000000.000002';
  expect(await deliver(makeCall(() => ({ messages: [{ client_msg_id: clientId, user: 'U000BOT', ts, thread_ts: thread }],
    has_more: false, response_metadata: { next_cursor: '' } })))).toEqual({ status: 'sent', reason: 'delivery-reconciled', ts });
  expect(readSlackSendReceipts({ stateRoot })).toMatchObject({ state: 'ok', receipts: [{ key, state: 'sent', channel, thread, ts }] });
  advance();
  expect(await deliver(makeCall(() => { throw new Error('duplicate must not scan'); }))).toEqual({ status: 'duplicate', reason: 'delivery-proved', ts });
  expect(posts).toBe(1);
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(scanBusInbox({ root: busRoot, now: () => now }).rows.map(row => row.envelope.id)).toEqual([envelope.id]);
  const after = readFleetBoard({ path: ledger, now });
  expect(after.claims).toEqual(before.claims);
  expect(after.proposals).toEqual(before.proposals);
});
