/** Real producer chain (leader ingest + owner rewrite -> journal requestId -> reply() -> deliverSlackEnvelope store key) proves the causal binding end to end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { leaderReplyEnvelopeId, leaderReplySendKey, slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';

vi.setConfig({ testTimeout: 30_000 });
// Ingest now awaits the unified owner-thread receipt (~1-2 s cold); poll past it.
const WAIT_MS = 15_000;
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const configText = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;
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


const readStore = () => JSON.parse(readFileSync(join(options.runsDir, 'slack-transport', 'messages.json'), 'utf8')) as { messages: Record<string, { state: string; channel: string; thread?: string }> };
const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date('2026-11-06T02:01:00Z') });

describe('Slack causal reply binding round trip', () => {
  it('journals the leader requestId, stores the reply under its derived key, and traces it answered', async () => {
    const call = fakeCall();
    await receive(call, async () => 'Morning leader brief\nShipped (last 12h): none', slackEvent("how's the fleet?"));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    const journal = readSlackJournal({ runsDir: options.runsDir });
    expect(journal.state).toBe('ok');
    const [row] = journal.entries;
    expect(row?.requestId).toMatch(/^[a-f0-9]{64}$/);
    const keys = Object.keys(readStore().messages);
    expect(keys).toEqual([leaderReplySendKey(row!.requestId!)]);
    // The producer helpers compose: requestId -> reply envelope id -> store key.
    expect(keys[0]).toBe(slackSendStoreKey(leaderReplyEnvelopeId(row!.requestId!)));
    const result = await vi.waitFor(() => { const t = trace(); expect(t.counts.answered).toBe(1); return t; }, { timeout: WAIT_MS });
    expect(result.rows[0]).toMatchObject({ outcome: 'answered', ingress: 'posted', channelId: 'D0FAKELEADER' });
    expect(JSON.stringify(result)).not.toContain(row!.requestId!);
  });

  it('journals a requestId for an owner request that gets no reply, and traces it unanswered', async () => {
    const call = fakeCall();
    await receive(call, async () => 'unused', slackEvent('please look at the build when you can', 'U0FAKEOWNER', 'Ev-plain'));
    const [row] = readSlackJournal({ runsDir: options.runsDir }).entries;
    expect(row?.requestId).toMatch(/^[a-f0-9]{64}$/);
    expect(posts(call)).toHaveLength(0);
    expect(trace().rows[0]).toMatchObject({ outcome: 'unanswered' });
  });

  it('never gives a request a reply identity when it is not leader-routed (peer path)', async () => {
    const call = fakeCall();
    await receive(call, async () => 'unused', slackEvent('hello from a teammate', 'U0FAKEPEER', 'Ev-peer'));
    const entries = readSlackJournal({ runsDir: options.runsDir }).entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.requestId).toBeUndefined();
    const rows = trace().rows;
    for (const r of rows) expect(r.outcome).toBe('uncertain');
  });
});
