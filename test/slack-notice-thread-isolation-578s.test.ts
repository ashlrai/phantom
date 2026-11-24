import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig, SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('isolates assignment receipts for identical thread timestamps across channels after an ambiguous post', async () => {
  vi.useFakeTimers();
  let now = Date.parse('2026-11-18T00:00:00Z');
  vi.setSystemTime(now);
  const dir = mkdtempSync(join(tmpdir(), 'slack-isolation-578s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs');
  const busRoot = join(dir, 'bus'), stateRoot = join(dir, 'transport');
  const paths = claimNoticePaths(runsRoot);
  const teamId = 'T000FAKE', bot = 'U000BOT', owner = 'U000OWNER';
  const channels = ['C000FAKEA', 'C000FAKEB'], thread = '1700000000.000001';
  const timestamps = ['1700000000.000002', '1700000000.000003'];
  const config: SlackBridgeConfig = { bridgeId: 'slack', teamId, ownUserId: bot, ownBotId: 'B000BOT',
    map: channels.map((channel, index) => ({ topic: `fake-topic-${index}`, channel })) };
  const teamIdentities = [{ channel: 'slack' as const, id: owner }];
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig,
    now: () => now, readBoard: () => readFleetBoard({ path: ledger, now }) }));
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, { path: ledger, now }));
  expect(await pass()).toMatchObject({ baselined: true, planned: 0, sent: 0, failed: 0 });
  now += 1_000; vi.setSystemTime(now);
  const claims = channels.map((channel, index) => {
    const result = must(claimFleetWork({ repo: `fake/repo-${index}`, task: `fake task ${index}`,
      agent: `fake-owner-${index}` }, { path: ledger, now }));
    expect(appendClaimThreadBinding(paths.bindings, { claimId: result.claim.id, repo: result.claim.repo,
      threadKey: `${teamId}/${channel}/${thread}` }, now)).toMatchObject({ ok: true, status: 'bound' });
    return result.claim;
  });
  const notice = await pass();
  expect(notice).toMatchObject({ planned: 2, sent: 2, failed: 0 });
  const original = scanBusInbox({ root: busRoot, now: () => now });
  expect(original).toMatchObject({ source: 'available', skipped: 0 });
  expect(original.rows).toHaveLength(2);
  const envelopes = channels.map((channel, index) => {
    const row = original.rows.find(item => item.envelope.channel_ref === `${teamId}/${channel}/${thread}`);
    if (!row) throw new Error(`missing envelope for ${channel}`);
    const delivery = notice.deliveries.find(item => item.threadKey === `${teamId}/${channel}/${thread}`);
    if (!delivery) throw new Error(`missing notice for ${channel}`);
    expect(row.envelope).toMatchObject({ channel: 'slack', body: { kind: 'note',
      text: expect.stringContaining(`ASSIGNED: ${claims[index]!.agent} `), inReplyTo: delivery.dedupeKey } });
    expect(delivery.receipt).toBe(`bus-note:${row.envelope.id}`);
    return row.envelope;
  });
  expect(new Set(envelopes.map(e => e.id)).size).toBe(2);
  expect(new Set(notice.deliveries.map(d => d.dedupeKey)).size).toBe(2);
  expect(readClaimNoticeSentRows(paths.sent)?.map(row => row.key).sort())
    .toEqual(notice.deliveries.map(d => d.dedupeKey).sort());
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'missing', receipts: [] });

  const posts: Record<string, unknown>[] = [];
  let history: Record<string, unknown>[] = [];
  const queries: Record<string, unknown>[] = [];
  // A fresh adapter and policy snapshot on each drain; only the external Slack API is faked.
  const deliver = (envelope: BusEnvelope) => {
    const call: SlackCall = async (method, input = {}) => {
      if (method === 'auth.test') return { team_id: teamId, user_id: bot, bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: input.channel, is_channel: true, context_team_id: teamId } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: input.user, team_id: teamId, ...(input.user === bot ? { is_bot: true } : {}) } };
      if (method === 'chat.postMessage') {
        posts.push(input);
        if (input.channel === channels[1]) throw new Error('fake ambiguous timeout');
        return { channel: input.channel, ts: timestamps[0] };
      }
      if (method === 'conversations.replies') { queries.push(input); return { messages: history, response_metadata: { next_cursor: '' } }; }
      throw new Error(`unexpected Slack method ${method}`);
    };
    return deliverSlackEnvelope(envelope, { config, teamIdentities, confirmedByMason: true,
      stateRoot, runsDir: runsRoot, busRoot, call });
  };
  expect(await deliver(envelopes[0]!)).toEqual({ status: 'sent', reason: 'delivery-proved', ts: timestamps[0] });
  expect(await deliver(envelopes[1]!)).toEqual({ status: 'uncertain', reason: 'transport-or-storage-unavailable' });
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({ channel: channels[0], thread_ts: thread });
  expect(posts[1]).toMatchObject({ channel: channels[1], thread_ts: thread });
  expect(posts[0]!.client_msg_id).not.toBe(posts[1]!.client_msg_id);
  const receipt = (index: number, state: 'attempted' | 'sent', ts?: string) => ({
    key: slackSendStoreKey(envelopes[index]!.id), channel: channels[index], thread, state, ...(ts ? { ts } : {}) });
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [
    receipt(0, 'sent', timestamps[0]), receipt(1, 'attempted') ] });
  history = [{ client_msg_id: posts[0]!.client_msg_id, user: bot, bot_id: 'B000BOT', thread_ts: thread, ts: timestamps[0] }];
  expect(await deliver(envelopes[1]!)).toEqual({ status: 'uncertain', reason: 'delivery-needs-reconciliation' });
  expect(queries).toEqual([{ channel: channels[1], ts: thread, limit: 100 }]);
  expect(posts).toHaveLength(2);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [
    receipt(0, 'sent', timestamps[0]), receipt(1, 'attempted') ] });
  history = [{ client_msg_id: posts[1]!.client_msg_id, user: bot, bot_id: 'B000BOT', thread_ts: thread, ts: timestamps[1] }];
  expect(await deliver(envelopes[1]!)).toEqual({ status: 'sent', reason: 'delivery-reconciled', ts: timestamps[1] });
  expect(queries).toEqual([{ channel: channels[1], ts: thread, limit: 100 }, { channel: channels[1], ts: thread, limit: 100 }]);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [
    receipt(0, 'sent', timestamps[0]), receipt(1, 'sent', timestamps[1]) ] });
  for (const envelope of envelopes) {
    expect(appendBusInbox(envelope, { root: busRoot, now: () => now })).toMatchObject({ status: 'duplicate', id: envelope.id });
    expect(await deliver(envelope)).toMatchObject({ status: 'duplicate', reason: 'delivery-proved' });
  }
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(scanBusInbox({ root: busRoot, now: () => now })).toEqual(original);
  expect(posts).toHaveLength(2);
  expect(queries).toHaveLength(2);
});
