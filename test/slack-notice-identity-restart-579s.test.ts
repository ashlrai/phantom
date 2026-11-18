import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig, SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(['team_id', 'user_id', 'bot_id'] as const)(
  'refuses attempted ASSIGNED reconciliation after restart with a different auth.test %s', async field => {
    vi.useFakeTimers();
    let now = Date.parse('2026-11-18T05:00:00Z');
    vi.setSystemTime(now);
    const root = mkdtempSync(join(tmpdir(), 'fake-slack-identity-579s-'));
    chmodSync(root, 0o700); roots.push(root);
    const ledger = join(root, 'coordination.jsonl'), runsRoot = join(root, 'runs');
    const busRoot = join(root, 'bus'), stateRoot = join(root, 'transport');
    const team = 'T000FAKE', channel = 'C000FAKE', thread = '1794978000.000001', ts = '1794978001.000001';
    const identity = { team_id: team, user_id: 'U000BOT', bot_id: 'B000BOT' };
    const threadKey = `${team}/${channel}/${thread}`;
    const config: SlackBridgeConfig = { bridgeId: 'slack', teamId: team, ownUserId: identity.user_id,
      ownBotId: identity.bot_id, map: [{ topic: 'fake-assignments', channel }] };
    const teamIdentities = [{ channel: 'slack' as const, id: 'U000OWNER' }];
    const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
    const board = () => readFleetBoard({ path: ledger, now });
    const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, killed: false,
      now: () => now, readBoard: board }));
    expect(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, { path: ledger, now }).ok).toBe(true);
    expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
    now += 1_000; vi.setSystemTime(now);
    const claimed = claimFleetWork({ repo: 'fake/phantom', task: 'fake identity restart', agent: 'fake-named-owner' },
      { path: ledger, now });
    if (!claimed.ok) throw new Error(`scratch claim failed: ${claimed.error}`);
    const { claim } = claimed.value, paths = claimNoticePaths(runsRoot);
    expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey }, now))
      .toMatchObject({ ok: true, status: 'bound' });
    const notice = await pass();
    expect(notice).toMatchObject({ planned: 1, sent: 1, failed: 0, deliveries: [{ state: 'ASSIGNED', threadKey }] });
    const scan = () => scanBusInbox({ root: busRoot, now: () => now });
    const original = scan();
    expect(original).toMatchObject({ source: 'available', skipped: 0 });
    expect(original.rows).toHaveLength(1);
    const envelope = original.rows[0]!.envelope;
    expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey,
      body: { kind: 'note', thread: `slack:${team}:${channel}:${thread}`, text: notice.deliveries[0]!.text } });
    expect(notice.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
    for (const text of ['ASSIGNED', claim.agent, claim.repo, claim.id]) expect(JSON.stringify(envelope.body)).toContain(text);
    expect(JSON.stringify(envelope.body)).not.toContain('VERIFIED');
    const durablePaths = [ledger, paths.sent, paths.prev, paths.bindings];
    const durableBytes = durablePaths.map(path => readFileSync(path));
    const originalBoard = board();
    expect(originalBoard).toMatchObject({ state: 'known', claims: [claim], proposals: [], messages: [] });
    const unchanged = () => {
      durablePaths.forEach((path, index) => expect(readFileSync(path)).toEqual(durableBytes[index]));
      expect(board()).toEqual(originalBoard);
      expect(board().claims[0]!.agent).toBe('fake-named-owner');
      expect(scan()).toEqual(original);
    };
    const posts: Record<string, unknown>[] = [], history: Record<string, unknown>[] = [];
    let clientId: unknown;
    // A new adapter, policy snapshot, abort signal and bus read for every consumer session.
    const drain = async (auth: typeof identity) => {
      const methods: string[] = [];
      const call: SlackCall = async (method, input = {}) => {
        methods.push(method);
        if (method === 'auth.test') return { ...auth };
        if (method === 'conversations.info') return { channel: { id: input.channel, context_team_id: team } };
        if (method === 'conversations.members') return { members: [identity.user_id, 'U000OWNER'] };
        if (method === 'users.info') return { user: { id: input.user, team_id: team, is_bot: input.user === identity.user_id } };
        if (method === 'chat.postMessage') {
          posts.push(input); clientId = input.client_msg_id;
          expect(input).toMatchObject({ channel, thread_ts: thread });
          expect(clientId).toEqual(expect.any(String));
          expect(readSlackSendReceipts({ stateRoot }).receipts).toEqual([attempted]);
          throw new Error('fake ambiguous transport failure after accepting post');
        }
        if (method === 'conversations.replies') {
          history.push(input);
          expect(input).toEqual({ channel, ts: thread, limit: 100 });
          return { messages: [{ client_msg_id: clientId, user: identity.user_id, bot_id: identity.bot_id,
            thread_ts: thread, ts, text: posts[0]!.text }], has_more: false, response_metadata: { next_cursor: '' } };
        }
        throw new Error(`unexpected fake Slack method: ${method}`);
      };
      const controller = new AbortController();
      expect(scan()).toEqual(original);
      try {
        const result = await deliverSlackEnvelope(scan().rows[0]!.envelope, { config: structuredClone(config),
          teamIdentities: structuredClone(teamIdentities), confirmedByMason: true, call, stateRoot,
          runsDir: runsRoot, busRoot, signal: controller.signal });
        return { result, methods };
      } finally { controller.abort(); }
    };
    const attempted = { key: slackSendStoreKey(envelope.id), state: 'attempted', channel, thread };
    const uncertain = { status: 'uncertain', reason: 'transport-or-storage-unavailable' };
    expect((await drain(identity)).result).toEqual(uncertain);
    expect(posts).toHaveLength(1);
    expect(history).toHaveLength(0);
    const receiptPath = join(stateRoot, 'messages.json'), attemptedBytes = readFileSync(receiptPath);
    expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [attempted] });
    unchanged();
    // Change exactly one authenticated field; configured policy remains the original identity.
    expect(await drain({ ...identity, [field]: `${identity[field]}OTHER` }))
      .toEqual({ result: uncertain, methods: ['auth.test'] });
    expect(history).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(readFileSync(receiptPath)).toEqual(attemptedBytes);
    expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [attempted] });
    unchanged();
    expect(await drain(identity)).toEqual({ result: { status: 'sent', reason: 'delivery-reconciled', ts },
      methods: ['auth.test', 'conversations.replies'] });
    const sent = { ...attempted, state: 'sent', ts };
    expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [sent] });
    const sentBytes = readFileSync(receiptPath);
    expect(await drain(identity)).toEqual({ result: { status: 'duplicate', reason: 'delivery-proved', ts }, methods: ['auth.test'] });
    expect(readFileSync(receiptPath)).toEqual(sentBytes);
    expect(history).toEqual([{ channel, ts: thread, limit: 100 }]);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).not.toContain('VERIFIED');
    expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0, deliveries: [] });
    unchanged(); // Transport recovery is delivery evidence, never claim completion or reassignment.
  },
);
