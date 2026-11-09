import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, ingestSlackLeaderEnvelope, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { readLeaderInbox, tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { OWNER_STATUS_FALLBACK } from '../src/core/agents/owner-status-reply.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 5000 });
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const configText = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;
const threadRef = 'slack:T0FAKETEAM:D0FAKELEADER:1793920000.000001';
const STATUS_TEXT = 'Phantom status, 21:00 ET\nShipped (last 12h): none';

function slackEvent(text: string, user = 'U0FAKEOWNER', eventId = 'Ev-status') {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T0FAKETEAM', event_id: eventId, event: {
    type: 'message', user, channel: 'D0FAKELEADER', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-leader-status-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeCall(input: { post?: () => Promise<Record<string, unknown>>; ownerIsBot?: boolean } = {}): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: input.ownerIsBot === true || body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return input.post ? input.post() : { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

/** Drives ingestSlackLeaderEnvelope through the real authenticated socket mapper. */
async function receive(call: SlackCall, statusReply: (runsDir: string, now: Date) => Promise<string>, payload: unknown, acknowledged = true) {
  let settled = false;
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  await vi.waitFor(() => expect(settled).toBe(true));
  if (acknowledged) await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
  return socket;
}

describe('owner "Phantom status" auto-answer over Slack', () => {
  it('answers the verified owner once in the same thread and still records the ask for the Leader', async () => {
    const call = fakeCall();
    const statusReply = vi.fn(async () => STATUS_TEXT);
    await receive(call, statusReply, slackEvent('Phantom status'));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1));
    expect(statusReply).toHaveBeenCalledOnce();
    expect(statusReply).toHaveBeenCalledWith(options.runsDir, new Date(options.now()));
    expect(posts(call)[0]?.[1]).toMatchObject({ channel: 'D0FAKELEADER', thread_ts: '1793920000.000001', text: `Leader: ${STATUS_TEXT}` });
    expect((await readLeaderInbox(options)).inbox.entries[0]?.text).toContain('Phantom status');

    // (b) A redelivered duplicate neither recomposes nor posts again, and the
    // Leader's own worker does not generate a second answer for the same ask.
    await receive(call, statusReply, slackEvent('Phantom status'));
    const generate = vi.fn(async () => 'Synthetic second answer');
    expect(await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: generate })).toMatchObject({ replies: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(statusReply).toHaveBeenCalledOnce();
    expect(posts(call)).toHaveLength(1);
  });

  it('leaves ordinary owner requests to the Leader with no auto reply', async () => {
    const call = fakeCall();
    const statusReply = vi.fn(async () => STATUS_TEXT);
    await receive(call, statusReply, slackEvent('please fix the release'));
    expect((await readLeaderInbox(options)).inbox.entries[0]?.text).toContain('please fix the release');
    expect(statusReply).not.toHaveBeenCalled();
    expect(posts(call)).toHaveLength(0);
  });

  it('gives an unverified sender nothing', async () => {
    const statusReply = vi.fn(async () => STATUS_TEXT);
    // A team peer who is not the configured owner.
    const peer = fakeCall();
    await receive(peer, statusReply, slackEvent('Phantom status', 'U0FAKEPEER', 'Ev-peer'), false);
    // The configured owner ID whose authenticated lookup is not a human account.
    const bot = fakeCall({ ownerIsBot: true });
    await receive(bot, statusReply, slackEvent('Phantom status', 'U0FAKEOWNER', 'Ev-bot'), false);
    // A forged envelope that never came through the socket mapper's owner proof.
    const forged: BusEnvelope = { id: 'synthetic-forged', from: 'slack:U0FAKEPEER', to: 'leaders', priority: 'P2', ttl: 60000, channel: 'slack', channel_ref: threadRef,
      origin_bridge: 'slack', external: false, sender: { agent_id: 'U0FAKEPEER', vendor: 'slack', human: true, team: true }, body: { kind: 'note', text: 'Phantom status' } };
    expect(await ingestSlackLeaderEnvelope(forged, { ...options, call: peer, statusReply })).toEqual({ owned: false, durable: false });
    expect(statusReply).not.toHaveBeenCalled();
    expect(posts(peer)).toHaveLength(0);
    expect(posts(bot)).toHaveLength(0);
    expect((await readLeaderInbox(options)).inbox.sourceState).toBe('missing');
  });

  it('posts the fixed fallback when the status read fails, without changing the ingest result', async () => {
    const call = fakeCall();
    const statusReply = vi.fn(async () => { throw new Error('synthetic status failure'); });
    const socket = await receive(call, statusReply, slackEvent('status?'));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-status-delivery' }));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1));
    expect(posts(call)[0]?.[1]).toMatchObject({ text: `Leader: ${OWNER_STATUS_FALLBACK}` });
  });

  it('keeps the ask durable and acknowledged when the status post itself fails', async () => {
    const call = fakeCall({ post: async () => { throw new Error('synthetic post failure'); } });
    const statusReply = vi.fn(async () => STATUS_TEXT);
    await receive(call, statusReply, slackEvent('fleet status'));
    await vi.waitFor(() => expect(posts(call).length).toBeGreaterThan(0));
    expect((await readLeaderInbox(options)).inbox.entries[0]?.text).toContain('fleet status');
  });
});
