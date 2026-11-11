import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, ingestSlackLeaderEnvelope, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput } from '../src/core/leader/status-digest-sources.js';

vi.setConfig({ testTimeout: 30_000 });
// Ingest now awaits the unified owner-thread receipt (~1-2 s cold); poll past it.
const WAIT_MS = 15_000;
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const configText = `[mason]\nidentities=[{channel="slack",id="U000TEST"}]\n[team]\nidentities=[{channel="slack",id="U000TEST"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D000TEST"\n`;
const threadRef = 'slack:T0FAKETEAM:D000TEST:1793920000.000001';

function slackEvent(text: string, user = 'U000TEST', eventId = 'Ev-status') {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T0FAKETEAM', event_id: eventId, event: {
    type: 'message', user, channel: 'D000TEST', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'status-reply-path-'));
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
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U000TEST'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: input.ownerIsBot === true || body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return input.post ? input.post() : { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

/** Drives ingestSlackLeaderEnvelope through the real authenticated socket mapper. */
async function receive(call: SlackCall, brief: (runsDir: string, now: Date) => Promise<string>, payload: unknown, acknowledged = true) {
  let settled = false;
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ brief }) });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
  if (acknowledged) await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
  return socket;
}


const fakeSources = {
  installedVersion: () => '3.29.15', publishedVersion: async () => '3.30.32',
  mergeFacts: async () => ({ shipped: [{ text: 'ashlrai/phantom#1: a' }], mergeCountUnavailable: false }),
  runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [{ lane: 'claude', running: 4, target: 8, held: false, heldReason: null, queued: 0, floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }] }),
  needs: () => ({ status: 'available', items: [{ text: 'need the Stripe API key' }] }),
  inbox: async () => ({ sourceState: 'healthy', entries: [{ at: '2026-11-05 21:00', source: 'Slack', priority: 'P0', text: 'Phantom status' }] }),
};

describe('"Phantom status" over Slack gets the digest in the same channel', () => {
  it('replies on D000TEST in the request thread with all five digest lines', async () => {
    const call = fakeCall();
    const brief = async (runsDir: string, now: Date) => ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, now, fakeSources))].join('\n');
    await receive(call, brief, slackEvent('Phantom status'));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    const body = posts(call)[0]?.[1] as { channel: string; thread_ts: string; text: string };
    expect(body).toMatchObject({ channel: 'D000TEST', thread_ts: '1793920000.000001' });
    expect(body.text).toContain('Leader: Phantom status, 21:00 ET\n');
    for (const line of ['App: installed 3.29.15 · published 3.30.32 · update pending', 'Merges: 1 in the last hour · 1 in the last 24h',
      'Lanes: claude 4/8', 'Needs Mason: 1 hard-limit ask waiting', 'Top P0: Phantom status (']) expect(body.text).toContain(line);
  });
});
