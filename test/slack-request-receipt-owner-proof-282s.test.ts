/**
 * RQ-PHX-SLACKRECEIPTOWNERPROOF282S -- receipt-vs-assignment proof for the
 * EXISTING Slack bridge owner path (Mason/Dot Nov 12 22:29-22:30 coordination
 * order). Supporting evidence only: this does not implement, activate or claim
 * the bridge; it drives one NON-status owner task through the real socket
 * wiring on isolated temp config/runs/bus roots with a synthetic SlackCall and
 * socket -- openSlackSocket -> slackEventToBus -> createSlackLeaderAdapter.route
 * -> ingestSlackLeaderEnvelope -> createLeaderNetwork.ingest, plus the durable
 * owner-thread copy via noteUnifiedOwner. No network, real Slack client,
 * credential lookup, daemon or real home writes; synthetic ids only.
 *
 * Contract under proof: a received Slack request is durable ingress evidence
 * (one MASON-INBOX record, one leader-network route, bus mirrors, one
 * owner-thread message). It is never an executor assignment, a running task or
 * a verification receipt -- the adapter returns only { owned, durable }, the
 * persisted route carries inbox/bus flags and no reply, and the work-order
 * contract labels even a well-formed order 'proposal-only'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { planWorkOrder } from '../src/core/comms/work-order.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const NOW = Date.parse('2026-11-06T02:00:00Z');
const TASK_TEXT = 'Please have the fleet review the merge-gate ordering change and report findings in this thread.';
const THREAD_REF = 'slack:T0FAKETEAM:D0FAKELEADER:1793920000.000001';
const SLACK_ENVELOPE_ID = 'slack-T0FAKETEAM-D0FAKELEADER-1793920001.000001';

let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const configText = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;

function slackEvent(text: string, eventId = 'Ev-task-282s') {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T0FAKETEAM', event_id: eventId, event: {
    type: 'message', user: 'U0FAKEOWNER', channel: 'D0FAKELEADER', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-receipt-282s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => NOW };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  // The owner-thread slack adapter stays configured only when its Phantom
  // Secrets handle NAME is present; no credential value exists anywhere.
  mkdirSync(join(options.configDir, 'comms'), { mode: 0o700 });
  writeFileSync(join(options.configDir, 'comms', 'owner-adapters.toml'), '[slack]\nsecretHandle="phm_SLACK_BOT_TOKEN"\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}

const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
const inboxPath = () => join(options.runsDir, 'leader', 'MASON-INBOX.md');
const outboxPath = () => join(options.runsDir, 'leader', 'MASON-OUTBOX.md');
const statePath = () => join(options.runsDir, 'leader', 'network-state.json');
const threadPath = () => join(options.runsDir, 'leader', 'owner-thread.json');
const busPath = () => join(options.busRoot, 'bus-inbox', 'messages.json');
const entries = (text: string) => text.split('\n').filter(line => line.startsWith('## '));
const requestIdOf = (heading: string) => /\[leader-network:([a-f0-9]{64})\]/.exec(heading)?.[1];

interface BusRow { cursor: number; receivedAt: number; envelope: Record<string, unknown> & { id: string; body?: Record<string, unknown> } }
function busRows(): BusRow[] {
  if (!existsSync(busPath())) return [];
  const store = JSON.parse(readFileSync(busPath(), 'utf8')) as { rows?: BusRow[] };
  return store.rows ?? [];
}
function ownerThread(): { messages: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(threadPath(), 'utf8')) as { messages: Array<Record<string, unknown>> };
}
function leaderState(): { routes: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(statePath(), 'utf8')) as { routes: Record<string, Record<string, unknown>> };
}

/** One Socket Mode delivery through the production wiring, same seam shape as
 * test/slack-leader-roundtrip.test.ts (pattern reused, not imported). */
async function receive(call: SlackCall, payload: unknown) {
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply() });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, handler: (event: { data?: unknown }) => void) => { handlers[type] = handler; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: adapter, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  // The socket acks only after the Leader record is durable; that settle is
  // the awaited durable effect, never a sleep.
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalled(), { timeout: WAIT_MS });
  return socket;
}

describe('Slack non-status owner request: received is not assigned', () => {
  it('records exactly one durable ingress and owner-thread receipt with source correlation, and posts no reply', async () => {
    const call = fakeCall();
    const socket = await receive(call, slackEvent(TASK_TEXT));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-task-282s-delivery' }));

    // Leader ingress: one MASON-INBOX record keyed by its request id.
    const inbox = readFileSync(inboxPath(), 'utf8');
    const headings = entries(inbox);
    expect(headings).toHaveLength(1);
    expect(headings[0]).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET \(Operator, slack\) PRIORITY P0 \[leader-network:[a-f0-9]{64}\]$/);
    const requestId = requestIdOf(headings[0]!)!;
    expect(inbox).toContain(TASK_TEXT);

    // Persisted leader route: receipt fields only -- durable inbox/bus flags,
    // preserved source channel/thread correlation, and no reply or assignment.
    const route = leaderState().routes[requestId]!;
    expect(Object.keys(leaderState().routes)).toEqual([requestId]);
    expect(Object.keys(route).sort()).toEqual(
      ['bus', 'channel', 'channelRef', 'fingerprint', 'inbox', 'message', 'receivedAt', 'recipient'].sort());
    expect(route).toMatchObject({ channel: 'slack', recipient: 'U0FAKEOWNER', channelRef: THREAD_REF, inbox: true, bus: true, receivedAt: NOW });
    expect(route['reply']).toBeUndefined();
    const routed = route['message'] as Record<string, unknown>;
    expect(routed).toMatchObject({
      id: expect.stringMatching(/^slack-owner-[a-f0-9]{32}$/), from: 'mason', to: 'leader', priority: 'P0',
      channel: 'slack', channel_ref: THREAD_REF, origin_bridge: 'slack',
    });
    expect(routed['body']).toMatchObject({ kind: 'note', text: TASK_TEXT, thread: THREAD_REF });
    // No persisted field anywhere claims assignment, execution or verification.
    expect(readFileSync(statePath(), 'utf8')).not.toMatch(/"(assigned|assignee|executor|running|claimed|verified|dispatched)"\s*:/);

    // Bus mirrors: the routed leader envelope plus the owner-thread copy.
    const rows = busRows();
    expect(rows).toHaveLength(2);
    const leaderRow = rows.find(row => String(row.envelope.id).startsWith('slack-owner-'));
    expect(leaderRow?.envelope).toMatchObject({
      from: 'mason', to: 'leader', channel: 'slack', channel_ref: THREAD_REF,
      origin_bridge: 'leader-network', priority: 'P0',
    });
    expect(leaderRow?.envelope.body).toMatchObject({ kind: 'note', text: TASK_TEXT, thread: THREAD_REF });
    const threadRow = rows.find(row => row.envelope.id === `ot-${SLACK_ENVELOPE_ID}`);
    expect(threadRow?.envelope).toMatchObject({ channel: 'slack', channel_ref: 'owner', origin_bridge: 'owner-thread', from: 'mason', to: 'leader' });
    expect(threadRow?.envelope.body).toMatchObject({ kind: 'owner-thread', threadId: 'owner', channel: 'slack', text: TASK_TEXT });

    // Owner thread: one inbound receipt preserving channel and Slack thread ref.
    const messages = ownerThread().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      seq: 1, id: 'm1', channel: 'slack', senderId: 'U0FAKEOWNER', direction: 'inbound',
      idempotencyKey: SLACK_ENVELOPE_ID, channelRef: THREAD_REF, text: TASK_TEXT,
      at: new Date(NOW).toISOString(),
    });
    expect(messages[0]!['replyTo']).toBeUndefined();
    expect(messages[0]!['fanout']).toBeUndefined();

    // Nothing answered, drafted or dispatched: RECEIVED only, no RUNNING/VERIFIED.
    expect(posts(call)).toHaveLength(0);
    expect(existsSync(outboxPath())).toBe(false);

    // The adapter's own returned receipt is exactly { owned, durable } -- no
    // request id, assignment or verification field exists to misread.
    const policy = readSlackDeliveryPolicy(options)!;
    const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply() });
    const decision = adapter.normalize(
      { type: 'message', team: 'T0FAKETEAM', user: 'U0FAKEOWNER', channel: 'D0FAKELEADER',
        ts: '1793920001.000001', thread_ts: '1793920000.000001', text: TASK_TEXT },
      { config: policy.config, teamIdentities: policy.teamIdentities });
    expect(decision.status).toBe('ingest');
    if (decision.status !== 'ingest') return;
    const result = await adapter.route(decision.envelope);
    expect(Object.keys(result).sort()).toEqual(['durable', 'owned']);
    expect(result).toEqual({ owned: true, durable: true });

    // Contract check: even a well-formed structured order is proposal-only.
    const plan = planWorkOrder({
      id: 'wo-282s-1', type: 'implementation', repo: 'ashlrai/phantom',
      task: 'Produce the receipt evidence table', acceptance: 'Table marks unsupported states unknown', replyChannel: 'slack',
    });
    expect(plan).toMatchObject({ destination: 'fleet', authority: 'proposal-only' });
    expect(Object.keys(plan!).sort()).toEqual(['authority', 'destination', 'order']);
  });

  it('dedupes a Socket Mode redelivery of the same source event to the same single receipts', async () => {
    const call = fakeCall();
    await receive(call, slackEvent(TASK_TEXT));
    const firstId = requestIdOf(entries(readFileSync(inboxPath(), 'utf8'))[0]!)!;

    const socket = await receive(call, slackEvent(TASK_TEXT));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-task-282s-delivery' }));

    // Replay is durable-acknowledged but writes nothing new anywhere.
    const headings = entries(readFileSync(inboxPath(), 'utf8'));
    expect(headings).toHaveLength(1);
    expect(requestIdOf(headings[0]!)).toBe(firstId);
    const state = leaderState();
    expect(Object.keys(state.routes)).toEqual([firstId]);
    expect(state.routes[firstId]).toMatchObject({ inbox: true, bus: true });
    expect(state.routes[firstId]!['reply']).toBeUndefined();
    expect(ownerThread().messages).toHaveLength(1);
    expect(busRows()).toHaveLength(2);
    expect(posts(call)).toHaveLength(0);
  });
});
