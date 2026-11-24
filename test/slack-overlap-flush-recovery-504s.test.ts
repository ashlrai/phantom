import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { createSlackLeaderAdapter, flushSlackLeaderReplies, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const owner = 'U0OWNER', bot = 'U0BOT', channel = 'D0LEADER', team = 'T0FAKE';
const thread = '1793920000.000001', messageTs = '1793920001.000001', replyTs = '1793920002.000001';
const config = `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Route = { owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> };

describe('overlapping Slack flush and durable native-send recovery', { timeout: 15000 }, () => {
  it.each(['ambiguous failure', 'success'] as const)('keeps one answer when the pending native send returns %s', async outcome => {
    const root = mkdtempSync(join(tmpdir(), 'slack-overlap-504s-'));
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), config, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const entered = deferred<void>(), release = deferred<void>();
    const posts: Record<string, unknown>[] = [], lookups: Record<string, unknown>[] = [];
    let visible = false;
    const call: SlackCall = async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0BOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
      if (method === 'chat.postMessage') {
        posts.push(body);
        entered.resolve(); // Transport has already persisted attempted and holds its real lock.
        await release.promise;
        if (outcome === 'ambiguous failure') throw new Error('synthetic lost native response');
        return { channel, ts: replyTs };
      }
      if (method === 'conversations.replies') {
        lookups.push(body);
        return { messages: visible ? [{ client_msg_id: posts[0]!.client_msg_id, user: bot, thread_ts: thread, ts: replyTs }] : [] };
      }
      throw new Error(`unexpected synthetic method: ${method}`);
    };
    const pendingRoutes: Promise<Route>[] = [];
    const sockets: { close(): void }[] = [];
    let closed = 0;
    // Each receipt uses a new adapter and socket over the same disk roots.
    const receive = async (delivery: string) => {
      const policy = readSlackDeliveryPolicy(options)!;
      const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: {
        ask: text => text === 'Phantom status', compose: async () => 'Synthetic status', fallback: 'unavailable',
      } });
      const routed = deferred<Route>(), acked = deferred<string>();
      const handlers: Record<string, (event: { data?: unknown }) => void> = {};
      const socket = { readyState: 1,
        addEventListener: (type: string, handler: (event: { data?: unknown }) => void) => { handlers[type] = handler; },
        send: (data: string) => acked.resolve(data), close: () => { closed++; },
      };
      sockets.push(socket);
      await openSlackSocket({ call, config: policy.config,
        ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
        leaderAdapter: { ...adapter, route: async envelope => {
          const pending = adapter.route(envelope);
          pendingRoutes.push(pending);
          const result = await pending;
          routed.resolve(result);
          return result;
        } }, connect: () => socket,
      });
      handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: delivery, payload: {
        team_id: team, event_id: 'Ev-overlap-504s', event: { type: 'message', user: owner, channel, ts: messageTs, thread_ts: thread, text: 'Phantom status' },
      } }) });
      const result = await routed.promise;
      expect(result).toMatchObject({ owned: true, durable: true });
      expect(JSON.parse(await acked.promise)).toEqual({ envelope_id: delivery });
      return result;
    };
    // These readers reopen durable files on every call, retaining no adapter state.
    const stateRoot = join(options.runsDir, 'slack-transport');
    const receipts = () => readSlackSendReceipts({ stateRoot });
    const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot, now: () => new Date('2026-11-06T02:01:00Z') });
    const inbox = () => listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    try {
      const initial = await receive('delivery-first');
      await entered.promise;
      expect(initial.statusAnswer).toBeDefined();
      const journal = readSlackJournal({ runsDir: options.runsDir });
      expect(journal.state).toBe('ok');
      const ingress = journal.entries.filter(row => row.decision === 'ingested');
      expect(ingress).toHaveLength(1);
      const requestId = ingress[0]!.requestId!;
      expect(requestId).toMatch(/^[a-f0-9]{64}$/);
      const attempted = { key: leaderReplySendKey(requestId), state: 'attempted', channel, thread };
      expect(receipts()).toEqual({ state: 'ok', receipts: [attempted] });
      const before = inbox();
      expect(before.status).toBe('ok');
      if (before.status !== 'ok') throw new Error('synthetic inbox unavailable');
      expect(before.messages.filter(row => row.envelope.from === 'mason')).toHaveLength(1);
      const uncertain = () => {
        expect(trace()).toMatchObject({ sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, uncertain: 1, answered: 0 },
          rows: [{ channelId: channel, threadTs: thread, messageTs, ingress: 'posted', outcome: 'uncertain' }] });
        expect(trace().rows[0]!.replyTs).toBeUndefined();
      };
      uncertain();
      // Fresh network construction must not treat contention as proof of delivery.
      expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
      expect(posts).toHaveLength(1);
      expect(receipts()).toEqual({ state: 'ok', receipts: [attempted] });
      expect(lookups).toHaveLength(0);
      expect(inbox()).toEqual(before);
      uncertain();

      release.resolve();
      expect(await initial.statusAnswer).toMatchObject({ answered: outcome === 'success' });
      if (outcome === 'ambiguous failure') {
        uncertain();
        expect(receipts()).toEqual({ state: 'ok', receipts: [attempted] });
        expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
        uncertain();
        expect(lookups).toEqual([{ channel, ts: thread, limit: 100 }]);
        visible = true;
        expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 1 });
        expect(lookups).toEqual([{ channel, ts: thread, limit: 100 }, { channel, ts: thread, limit: 100 }]);
      } else {
        // A successful native return persists terminal proof before the next flush.
        expect(lookups).toHaveLength(0);
      }
      const answered = trace();
      expect(answered).toMatchObject({ sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, answered: 1, uncertain: 0 },
        rows: [{ channelId: channel, threadTs: thread, messageTs, ingress: 'posted', outcome: 'answered', replyTs }] });
      expect(receipts()).toEqual({ state: 'ok', receipts: [{ ...attempted, state: 'sent', ts: replyTs }] });
      expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
      expect((await receive('delivery-redelivered')).statusAnswer).toBeUndefined();
      expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ channel, thread_ts: thread, text: 'Leader: Synthetic status', client_msg_id: expect.any(String) });
      expect(inbox()).toEqual(before);
      expect(trace()).toEqual(answered);
      expect(receipts()).toEqual({ state: 'ok', receipts: [{ ...attempted, state: 'sent', ts: replyTs }] });
      expect(lookups).toHaveLength(outcome === 'ambiguous failure' ? 2 : 0);
      expect(readSlackJournal({ runsDir: options.runsDir }).entries.filter(row => row.decision === 'ingested')).toHaveLength(1);
    } finally {
      release.resolve();
      try {
        await Promise.allSettled(pendingRoutes.map(async pending => {
          const result = await pending;
          await result.statusAnswer;
        }));
      } finally {
        for (const socket of sockets) socket.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
    expect(closed).toBe(sockets.length);
  });
});
