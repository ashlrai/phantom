import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';

let root = '';
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const owner = 'U0FAKEOWNER', bot = 'U0FAKEBOT', channel = 'D0FAKELEADER', team = 'T0FAKETEAM';
const thread = '1793920000.000001', firstTs = '1793920001.000001', replyTs = '1793920002.000001';

it('acks a new delivery envelope after restart without replying twice to the same owner message', async () => {
  root = mkdtempSync(join(tmpdir(), 'slack-redelivery-497s-'));
  const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const posts: Record<string, unknown>[] = [];
  const newCall = (): SlackCall => vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
    if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
    if (method === 'chat.postMessage') { posts.push(body); return { channel, ts: posts.length === 1 ? replyTs : '1793920004.000001' }; }
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected synthetic Slack method');
  });
  const inbox = () => listBusInboxAfter(0, 100, { root: options.busRoot, now: options.now });
  const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date(options.now()) });
  const receipts = () => readSlackSendReceipts({ stateRoot: join(options.runsDir, 'slack-transport') });
  const brief = vi.fn(async () => 'Morning leader brief\nShipped (last 12h): none; synthetic status only');
  const freshRuntime = async () => {
    const policy = readSlackDeliveryPolicy(options)!;
    const adapter = createSlackLeaderAdapter({ ...options, call: newCall(), statusReply: ownerStatusReply({ brief,
      board: () => listWorkBoard({ root: options.busRoot, now: options.now() }),
      snapshot: async () => { throw new Error('synthetic snapshot unavailable'); },
    }) });
    let routed: Awaited<ReturnType<typeof adapter.route>> | undefined;
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; }, send: vi.fn(), close: vi.fn() };
    const abort = new AbortController();
    await openSlackSocket({ call: newCall(), config: policy.config, signal: abort.signal,
      ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
      leaderAdapter: { ...adapter, route: async envelope => routed = await adapter.route(envelope) }, connect: () => socket });
    return { receive: async (eventId: string, ts: string, delivery: string) => {
      routed = undefined;
      handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: delivery, payload: { team_id: team, event_id: eventId,
        event: { type: 'message', user: owner, channel, ts, thread_ts: thread, text: 'Phantom status' } } }) });
      await vi.waitFor(() => expect(routed).toMatchObject({ owned: true, durable: true }), { timeout: 15000 });
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: delivery })), { timeout: 15000 });
      return await routed!.statusAnswer;
    }, close: () => { abort.abort(); expect(socket.close).toHaveBeenCalledOnce(); } };
  };
  let first: Awaited<ReturnType<typeof freshRuntime>> | undefined = await freshRuntime();
  expect(await first.receive('Ev-FAKE-original', firstTs, 'FAKE-delivery-1')).toMatchObject({ answered: true });
  expect(receipts()).toMatchObject({ state: 'ok', receipts: [{ state: 'sent', channel, thread, ts: replyTs }] });
  const before = inbox();
  expect(before.status).toBe('ok');
  expect(trace().rows).toEqual([expect.objectContaining({ messageTs: firstTs, replyTs, outcome: 'answered' })]);
  first.close();
  first = undefined; // Discard all first socket/adapter closures; only the temporary disk roots survive.
  const restarted = await freshRuntime();
  try {
    expect(await restarted.receive('Ev-FAKE-original', firstTs, 'FAKE-delivery-2')).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(brief).toHaveBeenCalledOnce();
    expect(inbox()).toEqual(before); // No second independently dispatched request or reply.
    const recovered = trace();
    expect(recovered.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(recovered.rows.length).toBeGreaterThan(0);
    expect(recovered.rows.every(row => row.messageTs === firstTs && row.replyTs === replyTs && row.outcome === 'answered')).toBe(true);
    // Trace counts journal rows, including duplicates if retained; unique work uses request identity.
    expect(recovered.counts.answered).toBe(recovered.rows.length);
    const journal = readSlackJournal({ runsDir: options.runsDir });
    expect(journal.state).toBe('ok');
    const ids = journal.entries.filter(row => row.decision === 'ingested').map(row => row.requestId);
    expect(ids.every(id => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(receipts().receipts).toHaveLength(1);
    expect(await restarted.receive('Ev-FAKE-new-ask', '1793920003.000001', 'FAKE-delivery-3')).toMatchObject({ answered: true });
    expect(posts).toHaveLength(2);
    expect(brief).toHaveBeenCalledTimes(2);
    expect(posts.every(post => post.channel === channel && post.thread_ts === thread && String(post.text).includes('synthetic status only'))).toBe(true);
    expect(new Set(trace().rows.map(row => row.messageTs))).toEqual(new Set([firstTs, '1793920003.000001']));
    expect(trace().rows.filter(row => row.messageTs !== firstTs)).toEqual([expect.objectContaining({ outcome: 'answered', replyTs: '1793920004.000001' })]);
    expect(receipts().receipts).toHaveLength(2);
    const board = listWorkBoard({ root: options.busRoot, now: options.now() });
    expect(board.inbox).toBe('ok');
    expect(board.items).toHaveLength(2);
    expect(board.items.every(item => item.owner === null && item.claimReceipt === null && item.state === 'RECEIVED')).toBe(true);
    const files = readdirSync(root, { recursive: true }).map(String);
    expect(files.filter(file => /(?:claims\.json|coordination\.jsonl|queue\.v1\.json|work-dispatch\.json)$/.test(file))).toEqual([]);
  } finally { restarted.close(); }
}, 30000);
