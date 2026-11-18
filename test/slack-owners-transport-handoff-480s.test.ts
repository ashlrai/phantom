/** Real durable ownership -> owner composer -> socket/Leader -> Slack delivery; no live I/O. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { defaultOwnersReply, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readSurfaceOwner } from '../src/core/fleet/surface-owner.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const OPERATOR = 'U000TEST', CHANNEL = 'D000TEST', TEAM = 'T0FAKETEAM';
const THREAD_TS = '1793920000.000001';
const POST_TS = '1793920002.000001';
const configText = `[mason]\nidentities=[{channel="slack",id="${OPERATOR}"}]\n` +
  `[team]\nidentities=[{channel="slack",id="${OPERATOR}"},{channel="slack",id="U0FAKEPEER"}]\n` +
  `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\n` +
  `bot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n` +
  `[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`;


let root: string;
let now = Date.parse('2026-11-13T18:13:00.000Z');
let path: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const owners = vi.fn((date: Date) => defaultOwnersReply(date, {
  read: surface => readSurfaceOwner(surface, {
    board: opts => readFleetBoard({ path, now: opts?.now }),
    log: async () => [], now: () => date.getTime(),
  }),
}));
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`fixture write failed: ${result.error}`);
  return result.value;
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function fakeCall(input: { post?: () => Promise<Record<string, unknown>> } = {}): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', OPERATOR], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return input.post ? input.post() : { channel: body.channel, ts: POST_TS };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
const postBody = (call: SlackCall, index: number) => posts(call)[index]?.[1] as { channel: string; thread_ts: string; text: string };

interface SendReceiptRow { state: string; channel: string; thread?: string; ts?: string }
/** The transport's durable delivery receipts; a 'sent' row is the proof a post landed. */
function sentReceipts(): SendReceiptRow[] {
  const store = JSON.parse(readFileSync(join(options.runsDir, 'slack-transport', 'messages.json'), 'utf8')) as { messages: Record<string, SendReceiptRow> };
  return Object.values(store.messages).filter(row => row.state === 'sent');
}

function slackEvent(text: string, eventId: string, ts: string, threadTs: string) {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: TEAM, event_id: eventId, event: {
    type: 'message', user: OPERATOR, channel: CHANNEL, ts, thread_ts: threadTs, text } } };
}

/** One inbound event through the real socket handler; a fresh adapter instance
 * per call, and the detached in-thread answer awaited to completion. */
async function receive(call: SlackCall, payload: unknown) {
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ owners }) });
  let routed: { owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> } | undefined;
  let settled = false;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return routed = await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
  const answer = routed?.statusAnswer ? await routed.statusAnswer : undefined;
  return { routed, answer, socket };
}

describe('durable owners answer delivered through Slack', () => {
  it('rereads claim, handoff, corrupt evidence and return across adapters, fencing replay', async () => {
    root = mkdtempSync(join(tmpdir(), 'fake-owners-transport-480s-'));
    path = join(root, 'fake-ledger.jsonl');
    options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => now };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const task = 'fake private task naming slack-bridge', artifact = 'fake-return-proof.txt';
    const alpha = 'fake-agent-alpha', beta = 'fake-agent-beta';
    const claim = must(claimFleetWork({ repo: 'ashlrai/phantom', task, agent: alpha }, { path, now }));
    const forbidden = [root, path, task, artifact, claim.lease, claim.claim.id, 'leaseHash'];
    const call = fakeCall();
    let count = 0;
    const ask = async (expected: string, absent: string[]) => {
      const bytes = readFileSync(path);
      const index = ++count;
      const thread = index === 1 ? THREAD_TS : `17939200${index}0.000001`;
      const event = slackEvent('who owns the bridge', `Ev-owners-${index}`, `17939200${index}1.000001`, thread);
      const result = await receive(call, event);
      expect(result.routed).toMatchObject({ owned: true, durable: true });
      expect(result.answer).toEqual({ answered: true, reason: 'answered in-thread' });
      expect(posts(call)).toHaveLength(index);
      const body = postBody(call, index - 1);
      expect(body).toMatchObject({ channel: CHANNEL, thread_ts: thread });
      expect(body.text).toContain(expected);
      expect(body.text).toContain(`Phantom owners, as of ${new Date(now).toISOString()}`);
      expect(body.text.endsWith('Claims are advisory; this reply assigns nothing.')).toBe(true);
      expect(body.text.length).toBeLessThanOrEqual(900);
      for (const value of [...forbidden, ...absent]) expect(body.text).not.toContain(value);
      expect(readFileSync(path)).toEqual(bytes);
      const receipts = sentReceipts();
      expect(receipts).toHaveLength(index);
      expect(receipts.filter(row => row.channel === CHANNEL && row.thread === thread && row.ts === POST_TS)).toHaveLength(1);
      expect(readFileSync(join(options.runsDir, 'leader', 'MASON-OUTBOX.md'), 'utf8')).toContain(body.text);
      await vi.waitFor(() => expect(result.socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: `Ev-owners-${index}-delivery` })), { timeout: WAIT_MS });
      const replay = await receive(call, event);
      expect(replay.routed).toMatchObject({ owned: true, durable: true });
      expect(replay.answer).toBeUndefined();
      await vi.waitFor(() => expect(replay.socket.send).toHaveBeenCalled(), { timeout: WAIT_MS });
      expect(posts(call)).toHaveLength(index);
      expect(sentReceipts()).toEqual(receipts);
      expect(readFileSync(path)).toEqual(bytes);
      expect(owners).toHaveBeenCalledTimes(index);
      now += 1000;
    };
    await ask(`slack-bridge: ${alpha} (advisory claim`, [beta]);
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: alpha, lease: claim.lease, to: beta }, { path, now }));
    forbidden.push(handoff.lease);
    await ask(`slack-bridge: ${beta} (advisory claim`, [alpha]);
    const valid = readFileSync(path);
    writeFileSync(path, 'fake corrupt ledger\n');
    await ask('slack-bridge: UNKNOWN (coordination ledger: missing or unreadable)', [alpha, beta, 'slack-bridge: no live owner']);
    writeFileSync(path, valid);
    expect(returnFleetClaim({ id: claim.claim.id, agent: beta, lease: handoff.lease, artifact }, { path, now }))
      .toMatchObject({ ok: true, outcome: 'returned' });
    await ask('slack-bridge: no live owner', [alpha, beta, 'slack-bridge: UNKNOWN']);
  });
});
