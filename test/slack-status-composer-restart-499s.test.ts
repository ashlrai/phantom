import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, flushSlackLeaderReplies, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const owner = 'U0OWNER', bot = 'U0BOT', channel = 'D0LEADER', team = 'T0FAKE', thread = '1793920000.000001';
const fallback = 'Status unavailable; please try again.';
const config = `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`;
let root = '';
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

const event = (id: string, ts: string, text: string) => ({ type: 'events_api', envelope_id: `${id}-delivery`, payload: {
  team_id: team, event_id: id, event: { type: 'message', user: owner, channel, ts, thread_ts: thread, text },
} });

describe('status composer failure survives Slack adapter restart', { timeout: 30000 }, () => {
  it.each(['throw', 'deadline'] as const)('delivers the %s fallback once and recovers for a new request', async failure => {
    root = mkdtempSync(join(tmpdir(), 'slack-composer-499s-'));
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), config, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const call: SlackCall = vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0BOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
      if (method === 'chat.postMessage') return { channel, ts: String(body.text).includes(fallback) ? '1793920002.000001' : '1793920004.000001' };
      throw new Error(`unexpected synthetic method: ${method}`);
    });
    const compose = vi.fn(async (_runsDir: string, _now: Date, text: string): Promise<string> => {
      if (text === 'Phantom status again') return 'Fresh synthetic status';
      if (failure === 'throw') throw new Error('synthetic composer failure');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return new Promise<string>(() => {});
    });
    const statusReply = { ask: (text: string) => text.startsWith('Phantom status'), compose, fallback };
    const receive = async (payload: ReturnType<typeof event>) => {
      const policy = readSlackDeliveryPolicy(options)!;
      const adapter = createSlackLeaderAdapter({ ...options, call, statusReply });
      let resolveRoute!: (value: Awaited<ReturnType<typeof adapter.route>>) => void;
      const routed = new Promise<Awaited<ReturnType<typeof adapter.route>>>(resolve => { resolveRoute = resolve; });
      const handlers: Record<string, (event: { data?: unknown }) => void> = {};
      const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; }, send: vi.fn(), close: vi.fn() };
      await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
        leaderAdapter: { ...adapter, route: async envelope => { const result = await adapter.route(envelope); resolveRoute(result); return result; } }, connect: () => socket });
      handlers.message!({ data: JSON.stringify(payload) });
      return routed;
    };
    const firstEvent = event('Ev-first-499', '1793920001.000001', 'Phantom status');
    const first = await receive(firstEvent);
    expect(first).toMatchObject({ owned: true, durable: true });
    expect(compose).toHaveBeenCalledExactlyOnceWith(options.runsDir, new Date(options.now()), 'Phantom status');
    if (failure === 'deadline') {
      try { await vi.advanceTimersByTimeAsync(10_000); } finally { vi.useRealTimers(); }
    }
    expect(await first.statusAnswer).toEqual({ answered: true, reason: 'answered in-thread' });
    const posts = () => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage').map(([, body]) => body);
    const firstPost = posts()[0]!;
    expect(firstPost).toEqual({ channel, thread_ts: thread, text: fallback, client_msg_id: expect.any(String) });
    const receipts = () => readSlackSendReceipts({ stateRoot: join(options.runsDir, 'slack-transport') });
    const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date(options.now() + 10_000) });
    const routes = () => Object.entries(JSON.parse(readFileSync(join(options.runsDir, 'leader/network-state.json'), 'utf8')).routes) as Array<[string, { message: { body: { text: string } }; reply: { text: string; delivered: boolean } }]>;
    const firstRoute = routes();
    expect(firstRoute).toHaveLength(1);
    expect(firstRoute[0]![1]).toMatchObject({ message: { body: { text: 'Phantom status' } }, reply: { text: fallback, delivered: true } });
    expect(receipts()).toEqual({ state: 'ok', receipts: [{ key: leaderReplySendKey(firstRoute[0]![0]), state: 'sent', channel, thread, ts: '1793920002.000001' }] });
    expect(trace()).toMatchObject({ sources: { journal: 'ok', sends: 'ok' }, rows: [{ messageTs: '1793920001.000001', threadTs: thread, ingress: 'posted', outcome: 'answered', replyTs: '1793920002.000001' }] });
    const before = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    const replay = await receive(firstEvent);
    expect(replay).toMatchObject({ owned: true, durable: true });
    expect(replay.statusAnswer).toBeUndefined();
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
    expect(posts()).toEqual([firstPost]);
    expect(routes()).toEqual(firstRoute);
    expect(listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now })).toEqual(before);
    expect(compose).toHaveBeenCalledTimes(1);
    const second = await receive(event('Ev-second-499', '1793920003.000001', 'Phantom status again'));
    expect(await second.statusAnswer).toEqual({ answered: true, reason: 'answered in-thread' });
    expect(compose).toHaveBeenLastCalledWith(options.runsDir, new Date(options.now()), 'Phantom status again');
    const secondPost = posts()[1]!;
    expect(secondPost).toMatchObject({ channel, thread_ts: thread, text: 'Leader: Fresh synthetic status', client_msg_id: expect.any(String) });
    expect(secondPost.client_msg_id).not.toBe(firstPost.client_msg_id);
    const allRoutes = routes();
    expect(allRoutes).toHaveLength(2);
    const secondRoute = allRoutes.find(([, route]) => route.message.body.text === 'Phantom status again')!;
    expect(secondRoute[1].reply).toMatchObject({ text: 'Fresh synthetic status', delivered: true });
    expect(receipts().receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: leaderReplySendKey(firstRoute[0]![0]), ts: '1793920002.000001', state: 'sent' }),
      expect.objectContaining({ key: leaderReplySendKey(secondRoute[0]), ts: '1793920004.000001', state: 'sent' }),
    ]));
    expect(receipts().receipts).toHaveLength(2);
    expect(trace().rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageTs: '1793920001.000001', outcome: 'answered', replyTs: '1793920002.000001' }),
      expect.objectContaining({ messageTs: '1793920003.000001', outcome: 'answered', replyTs: '1793920004.000001' }),
    ]));
    expect(trace().rows).toHaveLength(2);
    expect(posts()).toHaveLength(2);
  });
});
