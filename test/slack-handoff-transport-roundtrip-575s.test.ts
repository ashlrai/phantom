import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { claimFleetWork, handoffFleetClaim, postFleetMessage, readFleetBoard,
  releaseFleetClaim, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('delivers real A to B to A ownership transitions once each in the original Slack thread', async () => {
  vi.useFakeTimers();
  let now = Date.parse('2026-11-18T00:00:00Z');
  vi.setSystemTime(now);
  const dir = mkdtempSync(join(tmpdir(), 'slack-handoff-575s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs');
  const busRoot = join(dir, 'bus'), stateRoot = join(dir, 'transport');
  const paths = claimNoticePaths(runsRoot);
  const teamId = 'T000FAKE', channel = 'C000FAKE', thread = '1700000000.000001';
  const threadKey = `${teamId}/${channel}/${thread}`;
  const config: SlackBridgeConfig = { bridgeId: 'slack', teamId, ownUserId: 'U000BOT', ownBotId: 'B000BOT',
    map: [{ topic: 'fake-topic', channel }] };
  const teamIdentities = [{ channel: 'slack' as const, id: 'U000OWNER' }];
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
  // Reconstruct the real file-backed dependencies on every pass and transport invocation.
  const board = () => readFleetBoard({ path: ledger, now });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig,
    now: () => now, readBoard: board }));
  const advance = () => { now += 1_000; vi.setSystemTime(now); return { path: ledger, now }; };
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, { path: ledger, now }));
  expect(await pass()).toMatchObject({ baselined: true, planned: 0, failed: 0 });
  const initial = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task', agent: 'fake-owner-A' }, advance()));
  const id = initial.claim.id;
  expect(appendClaimThreadBinding(paths.bindings, { claimId: id, repo: initial.claim.repo, threadKey,
    pr: 7, head: 'abcdef1234567' }, now)).toMatchObject({ ok: true, status: 'bound' });
  const posts: Record<string, unknown>[] = [];
  const attempts: ReturnType<typeof readSlackSendReceipts>[] = [];
  const makeCall = (): SlackCall => async (method, input = {}) => {
    if (method === 'auth.test') return { team_id: teamId, user_id: 'U000BOT', bot_id: 'B000BOT' };
    if (method === 'conversations.info') return { channel: { id: input.channel, is_channel: true, context_team_id: teamId } };
    if (method === 'conversations.members') return { members: ['U000BOT', 'U000OWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: input.user, team_id: teamId, ...(input.user === 'U000BOT' ? { is_bot: true } : {}) } };
    if (method === 'chat.postMessage') {
      attempts.push(readSlackSendReceipts({ stateRoot }));
      posts.push(input);
      return { channel, ts: `1700000000.00000${posts.length + 1}` };
    }
    throw new Error(`unexpected Slack method ${method}`);
  };
  const deliver = (envelope: BusEnvelope) => deliverSlackEnvelope(envelope, { config, teamIdentities,
    confirmedByMason: true, stateRoot, runsDir: runsRoot, busRoot, call: makeCall() });
  const envelopes: BusEnvelope[] = [], keys: string[] = [];
  let current = initial;
  for (const [index, owner] of ['fake-owner-A', 'fake-owner-B', 'fake-owner-A'].entries()) {
    if (index > 0) {
      const previous = current;
      current = must(handoffFleetClaim({ id, agent: previous.claim.agent, lease: previous.lease, to: owner }, advance()));
      expect(current.lease).not.toBe(previous.lease);
      expect(current.claim.claimedAt).toBeGreaterThan(previous.claim.claimedAt);
      expect(releaseFleetClaim({ id, agent: previous.claim.agent, lease: previous.lease }, { path: ledger, now }))
        .toEqual({ ok: false, error: 'not-owner' });
    }
    expect(board()).toMatchObject({ state: 'known', claims: [current.claim], proposals: [], messages: [] });
    const notice = await pass();
    expect(notice).toMatchObject({ planned: 1, sent: 1, failed: 0 });
    const inbox = scanBusInbox({ root: busRoot, now: () => now });
    expect(inbox).toMatchObject({ source: 'available', skipped: 0 });
    expect(inbox.rows).toHaveLength(index + 1);
    const envelope = inbox.rows[index]!.envelope;
    expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey,
      body: { kind: 'note', text: expect.stringContaining(`ASSIGNED: ${owner} `),
        inReplyTo: notice.deliveries[0]!.dedupeKey } });
    expect(notice.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
    keys.push(notice.deliveries[0]!.dedupeKey); envelopes.push(envelope);
    // A bus receipt proves enqueue only; no receipt for this envelope exists yet.
    expect(readSlackSendReceipts({ stateRoot }).receipts).toHaveLength(index);
    const before = readFileSync(ledger, 'utf8');
    const ts = `1700000000.00000${index + 2}`;
    expect(await deliver(envelope)).toEqual({ status: 'sent', reason: 'delivery-proved', ts });
    expect(attempts[index]).toMatchObject({ state: 'ok', receipts: expect.arrayContaining([
      { key: slackSendStoreKey(envelope.id), state: 'attempted', channel, thread },
    ]) });
    expect(posts[index]).toMatchObject({ channel, thread_ts: thread,
      text: expect.stringContaining(`ASSIGNED: ${owner} `) });
    expect(JSON.stringify(posts[index])).not.toMatch(/RUNNING|VERIFIED/);
    for (const prior of envelopes) {
      expect(appendBusInbox(prior, { root: busRoot, now: () => now })).toMatchObject({ status: 'duplicate', id: prior.id });
      expect(await deliver(prior)).toMatchObject({ status: 'duplicate', reason: 'delivery-proved' });
    }
    expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
    expect(posts).toHaveLength(index + 1);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
    expect(board().claims).toEqual([current.claim]);
  }
  expect(new Set(envelopes.map(envelope => envelope.id)).size).toBe(3);
  expect(new Set(keys).size).toBe(3);
  expect(readClaimNoticeSentRows(paths.sent)?.map(row => row.key)).toEqual(keys);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: envelopes.map((envelope, index) => ({
    key: slackSendStoreKey(envelope.id), state: 'sent', channel, thread, ts: `1700000000.00000${index + 2}`,
  })) });
  // Even after A returns, A's original lease cannot validate current ownership.
  expect(releaseFleetClaim({ id, agent: initial.claim.agent, lease: initial.lease }, { path: ledger, now }))
    .toEqual({ ok: false, error: 'not-owner' });
  expect(board()).toMatchObject({ state: 'known', claims: [{ ...current.claim, agent: 'fake-owner-A' }], proposals: [], messages: [] });
  expect(posts).toHaveLength(3);
});
