import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, flushSlackLeaderReplies, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const owner = 'U0OWNER', bot = 'U0BOT', channel = 'D0LEADER', team = 'T0FAKE', thread = '1793920000.000001';
const config = `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`;
let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('status send uncertainty across adapter restart', { timeout: 30000 }, () => {
  it.each([false, true])('preserves the request with reconciliation evidence found: %s', async found => {
    root = mkdtempSync(join(tmpdir(), 'status-uncertain-481s-'));
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), config, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    let clientId = '';
    const call: SlackCall = vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0BOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
      if (method === 'chat.postMessage') { clientId = String(body.client_msg_id); throw new Error('synthetic lost response'); }
      if (method === 'conversations.replies') return { messages: found ? [{ client_msg_id: clientId, user: bot, thread_ts: thread, ts: '1793920002.000001' }] : [] };
      throw new Error('unexpected synthetic method');
    });
    const event = { type: 'events_api', envelope_id: 'synthetic-delivery', payload: { team_id: team, event_id: 'Ev-synthetic-481', event: { type: 'message', user: owner, channel, ts: '1793920001.000001', thread_ts: thread, text: 'Phantom status' } } };
    const receive = async () => {
      const policy = readSlackDeliveryPolicy(options)!;
      const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: { ask: text => text === 'Phantom status', compose: async () => 'Synthetic status', fallback: 'unavailable' } });
      let routed: Awaited<ReturnType<typeof adapter.route>> | undefined;
      const handlers: Record<string, (event: { data?: unknown }) => void> = {};
      const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; }, send: vi.fn(), close: vi.fn() };
      await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot }, leaderAdapter: { ...adapter, route: async envelope => routed = await adapter.route(envelope) }, connect: () => socket });
      handlers.message!({ data: JSON.stringify(event) });
      await vi.waitFor(() => expect(routed).toBeDefined(), { timeout: 15000 });
      return { routed: routed!, answer: await routed!.statusAnswer };
    };
    const first = await receive();
    expect(first.routed).toMatchObject({ owned: true, durable: true });
    expect(first.answer).toMatchObject({ answered: false });
    const receipts = () => readSlackSendReceipts({ stateRoot: join(options.runsDir, 'slack-transport') });
    expect(receipts()).toMatchObject({ state: 'ok', receipts: [{ state: 'attempted', channel, thread }] });
    const before = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    const replay = await receive();
    expect(replay.routed).toMatchObject({ owned: true, durable: true });
    expect(replay.answer).toBeUndefined();
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: found ? 1 : 0 });
    expect(receipts()).toMatchObject({ state: 'ok', receipts: [{ state: found ? 'sent' : 'attempted', channel, thread }] });
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
    const after = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    expect(after).toEqual(before);
    const state = JSON.parse(readFileSync(join(options.runsDir, 'leader/network-state.json'), 'utf8'));
    const routes = Object.values(state.routes) as Array<{ channelRef: string; message: { body: { text: string } }; reply: { delivered: boolean } }>;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ channelRef: `slack:${team}:${channel}:${thread}`, message: { body: { text: 'Phantom status' } }, reply: { delivered: found } });
  });
});
