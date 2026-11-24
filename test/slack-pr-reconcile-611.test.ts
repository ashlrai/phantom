/**
 * RQ-PHX-SLACKPRRECONCILE611C: pins the master behavior that superseded the five
 * open Slack PRs (#4275 #4280 #4519 #4885 #5312). Drives the real authenticated
 * socket mapper -> Leader adapter -> journal -> same-thread reply path. Fake ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { classifyIntentByRules } from '../src/core/vision/leader-intent.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const THREAD = '1793920000.000001';
const BRIEF = 'Morning leader brief\nShipped (last 12h): none';

let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };

const configText = `[mason]\nidentities=[{channel="slack",id="U000FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U000FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T000FAKE"\nown_user_id="U000FAKEBOT"\nown_bot_id="B000FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="C000FAKE"\n`;

const slackEvent = (text: string, eventId: string, delivery = `${eventId}-delivery`, ts = '1793920001.000001') => ({
  type: 'events_api', envelope_id: delivery,
  payload: { team_id: 'T000FAKE', event_id: eventId, event: { type: 'message', user: 'U000FAKEOWNER', channel: 'C000FAKE', ts, thread_ts: THREAD, text } },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-reconcile-611-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T000FAKE', user_id: 'U000FAKEBOT', bot_id: 'B000FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: false, is_private: true, context_team_id: 'T000FAKE' } };
    if (method === 'conversations.members') return { members: ['U000FAKEBOT', 'U000FAKEOWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T000FAKE', is_bot: body.user === 'U000FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

/** Feeds each payload through the real socket mapper, in order, waiting for the Leader route to settle for each. */
async function receive(call: SlackCall, payloads: unknown[]) {
  let settled = 0;
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ brief: async () => BRIEF }) });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled++; } } }, connect: () => socket });
  for (const [index, payload] of payloads.entries()) {
    handlers.message!({ data: JSON.stringify(payload) });
    await vi.waitFor(() => expect(settled).toBeGreaterThanOrEqual(index + 1), { timeout: WAIT_MS });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(index + 1), { timeout: WAIT_MS });
  }
  return socket;
}

const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date('2026-11-06T02:01:00Z') });

describe('Slack PR reconcile: the receipt-backed loop is on master', () => {
  it('a status ask gets a durable journal receipt and one same-thread reply, traced answered', async () => {
    const call = fakeCall();
    await receive(call, [slackEvent('Phantom status', 'Ev000STATUS')]);
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    const [, body] = posts(call)[0]!;
    expect(body).toMatchObject({ channel: 'C000FAKE', thread_ts: THREAD });
    expect(String((body as { text?: string }).text)).toContain('Phantom status');
    const journal = readSlackJournal({ runsDir: options.runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]?.requestId).toMatch(/^[a-f0-9]{64}$/);
    const result = await vi.waitFor(() => { const t = trace(); expect(t.counts.answered).toBe(1); return t; }, { timeout: WAIT_MS });
    expect(result.rows[0]).toMatchObject({ outcome: 'answered', channelId: 'C000FAKE' });
  });

  it('replaying the same Slack event id yields one ingress receipt and one reply', async () => {
    const call = fakeCall();
    // Same event_id redelivered under a fresh socket envelope id, as Slack does on retry.
    await receive(call, [slackEvent('Phantom status', 'Ev000REPLAY', 'delivery-1'), slackEvent('Phantom status', 'Ev000REPLAY', 'delivery-2')]);
    await vi.waitFor(() => expect(posts(call).length).toBeGreaterThanOrEqual(1), { timeout: WAIT_MS });
    expect(readSlackJournal({ runsDir: options.runsDir }).entries).toHaveLength(1);
    expect(posts(call)).toHaveLength(1);
    expect(trace().rows).toHaveLength(1);
  });

  it('control: a distinct message (new event id and ts) gets its own receipt', async () => {
    const call = fakeCall();
    await receive(call, [slackEvent('Phantom status', 'Ev000ONE', 'd-1'), slackEvent('Phantom status', 'Ev000TWO', 'd-2', '1793920009.000009')]);
    expect(readSlackJournal({ runsDir: options.runsDir }).entries).toHaveLength(2);
  });

  it('an ordinary owner message is journaled but gets no canned status reply', async () => {
    const call = fakeCall();
    await receive(call, [slackEvent('please look at the build when you can', 'Ev000PLAIN')]);
    expect(readSlackJournal({ runsDir: options.runsDir }).entries).toHaveLength(1);
    expect(posts(call)).toHaveLength(0);
    expect(trace().rows[0]).toMatchObject({ outcome: 'unanswered' });
  });
});

describe('Slack PR reconcile: status intent (#4519/#5312) is on master', () => {
  it.each(['status', 'Phantom status', 'leader: status?', 'phantom, sitrep'])('classifies %j as status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it('does not treat a real question as a status ask', () => {
    expect(classifyIntentByRules('please deploy the release').kind).not.toBe('status');
  });
});
