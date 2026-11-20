/** RQ-PHX-EVIDENCEASKSLACK682: a long owner evidence ask gets the recheck verdict in-thread and is still recorded in the Leader inbox. Hermetic: fake ids, injected seams, temp dirs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { readLeaderInbox } from '../src/core/agents/leader-network-runtime.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { OWNER_RECHECK_FALLBACK, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const RECHECK_TEXT = 'Phantom recheck, 2026-11-13T18:13:00.000Z\nRUNTIME VERIFIED host=fake-host\nCLAIMS VERIFIED active=0\nVerdict: UNKNOWN';
const EVIDENCE = 'Please recheck the current runtime rather than relying on yesterday’s blocked state. Return sanitized evidence of runtime identity, a fresh shared context/claims read, and the existing owner of the Example bridge. If this worker still cannot reach live state, report the exact missing bridge.';
const configText = `[mason]\nidentities=[{channel="slack",id="U000EXAMPLE"}]\n[team]\nidentities=[{channel="slack",id="U000EXAMPLE"}]\n[slack]\nbridge_id="slack"\nteam_id="T000EXAMPLE"\nown_user_id="U000BOTEXAM"\nown_bot_id="B000EXAMPLE"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="C000EXAMPLE"\n`;
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-evidence-ask-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-13T18:13:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const slackEvent = (text: string, eventId: string) => ({ type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T000EXAMPLE', event_id: eventId, event: {
  type: 'message', user: 'U000EXAMPLE', channel: 'C000EXAMPLE', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T000EXAMPLE', user_id: 'U000BOTEXAM', bot_id: 'B000EXAMPLE' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: false, is_channel: true, context_team_id: 'T000EXAMPLE' } };
    if (method === 'conversations.members') return { members: ['U000BOTEXAM', 'U000EXAMPLE'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T000EXAMPLE', is_bot: false } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: `${options.now() / 1000 + 1}.000001` };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

async function receive(call: SlackCall, deps: Parameters<typeof ownerStatusReply>[0], payload: unknown) {
  let settled = false;
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply(deps) });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot, now: () => new Date(options.now()) },
    leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
}

describe('long owner evidence ask over Slack', () => {
  it('records the message at ingest, replies once with the recheck, and ignores a redelivery', async () => {
    const call = fakeCall(), recheck = vi.fn(async () => RECHECK_TEXT), brief = vi.fn(async () => 'digest');
    await receive(call, { recheck, brief }, slackEvent(EVIDENCE, 'Ev-evidence'));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    const text = String(posts(call)[0]?.[1]?.text);
    expect(text).toContain('Phantom recheck (full message recorded for the Leader):\n' + RECHECK_TEXT);
    expect(text.startsWith('Leader: Phantom recheck (full message recorded for the Leader):')).toBe(true);
    expect(recheck).toHaveBeenCalledOnce();
    expect(brief).not.toHaveBeenCalled();
    expect((await readLeaderInbox(options)).inbox.entries[0]?.text).toContain('runtime identity');
    await receive(call, { recheck, brief }, slackEvent(EVIDENCE, 'Ev-evidence'));
    expect(recheck).toHaveBeenCalledOnce();
    expect(posts(call)).toHaveLength(1);
  });

  it('replies with the recheck fallback, not invented state, when the read throws', async () => {
    const call = fakeCall();
    await receive(call, { recheck: async () => { throw new Error('synthetic'); } }, slackEvent(EVIDENCE, 'Ev-fail'));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    expect(String(posts(call)[0]?.[1]?.text)).toContain(OWNER_RECHECK_FALLBACK);
    expect((await readLeaderInbox(options)).inbox.entries[0]?.text).toContain('runtime identity');
  });

  it('leaves a short "phantom status" ask on its existing path: one digest reply, ask recorded', async () => {
    const call = fakeCall(), recheck = vi.fn(async () => RECHECK_TEXT);
    await receive(call, { recheck, brief: async () => 'Phantom status, 21:00 ET\nShipped (last 12h): none', board: () => ({ items: [], inbox: 'ok' as const, truncated: false }) }, slackEvent('phantom status', 'Ev-status'));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    expect(String(posts(call)[0]?.[1]?.text)).toContain('Phantom status');
    expect(String(posts(call)[0]?.[1]?.text)).not.toContain('full message recorded');
    expect(recheck).not.toHaveBeenCalled();
    expect((await readLeaderInbox(options)).inbox.entries[0]?.text).toContain('phantom status');
  });
});
