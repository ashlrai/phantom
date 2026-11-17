/** Orders through the durable socket/inbox/reply path; only external transport
 * and process observations are fake. No composed answer or trace is injected. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { defaultOrdersReply, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';

vi.setConfig({ testTimeout: 60_000 });
const USER = 'U000TEST', CHANNEL = 'D000TEST', TEAM = 'T0FAKETEAM';
const JOB = 'RQ-SYNTHETIC-IDENTITY482', OTHER = 'RQ-SYNTHETIC-OTHER482';
const AT = '2026-11-14 12:00';
let root: string, ps: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const disk = (path: string, text: string) => writeFileSync(join(options.runsDir, path), text, { mode: 0o600 });
const orderLine = (text: string) => text.split('\n').find(line => line.startsWith(`${AT} · slack ·`));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-orders-disk-480s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-14T19:30:00Z') };
  for (const path of [options.configDir, ...['leader', 'queue/prompts', 'metrics'].map(p => join(options.runsDir, p))]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'),
    `[mason]\nidentities=[{channel="slack",id="${USER}"}]\n[team]\nidentities=[{channel="slack",id="${USER}"}]\n` +
    `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\n` +
    `bot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`);
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n');
  disk('leader/MASON-INBOX.md', '');
  disk('queue/ready.tsv', '');
  disk('queue/slots.json', JSON.stringify({ devin: { target: 2, floor: 0, ceiling: 6 } }));
  disk('metrics/jobs.jsonl', '');
  ps = '';
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', USER], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1794684602.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected synthetic method');
  });
}

async function receive(call: SlackCall, index: number, duplicate = false) {
  const policy = readSlackDeliveryPolicy(options)!;
  // Path adapters retain the production trace + slots readers. Process text
  // enters at runPs, so parsing, freshness and job membership remain real.
  const statusReply = ownerStatusReply({ orders: now => defaultOrdersReply(now, {
    read: opts => readOrderTrace({ ...opts, runsDir: options.runsDir }),
    live: () => listLiveWorkers({ runPs: async () => ps, now: options.now }),
    lanes: () => readLaneTargets({ runsDir: options.runsDir }),
  }) });
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply });
  let routed: { owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> } | undefined;
  let settled = false;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return routed = await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  const thread = `17946846${String(index).padStart(2, '0')}.000001`;
  handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: `Ev-orders-${index}-delivery`, payload: {
    team_id: TEAM, event_id: `Ev-orders-${index}`, event: { type: 'message', user: USER, channel: CHANNEL, ts: thread, thread_ts: thread, text: 'orders' },
  } }) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 15_000 });
  expect(routed).toMatchObject({ owned: true, durable: true });
  if (duplicate) {
    expect(routed?.statusAnswer).toBeUndefined();
    return '';
  }
  expect(await routed?.statusAnswer).toEqual({ answered: true, reason: 'answered in-thread' });
  const body = vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage').at(-1)?.[1] as { text: string };
  expect(body).toMatchObject({ channel: CHANNEL, thread_ts: thread });
  expect(body.text).toMatch(/^Leader: Phantom orders, as of 14:3[01] ET \(order-trace\)\n/);
  expect(readFileSync(join(options.runsDir, 'leader/MASON-OUTBOX.md'), 'utf8')).toContain(body.text.replace(/^Leader: /, ''));
  // Socket ack alone never proves delivery: require the transport's persisted
  // sent receipt for this exact request channel/thread after adapter recreation.
  const store = JSON.parse(readFileSync(join(options.runsDir, 'slack-transport/messages.json'), 'utf8')) as { messages: Record<string, unknown> };
  expect(Object.values(store.messages)).toContainEqual(expect.objectContaining({ state: 'sent', channel: CHANNEL, thread, ts: '1794684602.000001' }));
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: `Ev-orders-${index}-delivery` })), { timeout: 15_000 });
  return body.text;
}

it('uses the current exact worker identity on each fresh ask and deduplicates redelivery', async () => {
  disk('leader/MASON-INBOX.md', `## ${AT} ET (Mason, slack) PRIORITY P0\nPrivate synthetic order text.\n`);
  disk(`queue/prompts/${JOB}.md`, "Serves Mason's Nov 14 12:00 order. Fixture private prompt.\n");
  disk('queue/ready.tsv', `status\tid\tpool\ttier\trepo\ttitle\nREADY\t${JOB}\tdevin\twork\tphantom\tFixture private title\n`);
  disk(`${JOB}.launch`, `launched ${JOB} devin pid 482 base fake lease fixture-private-lease\n`);
  const protectedFiles = ['queue/ready.tsv', 'metrics/jobs.jsonl', `queue/prompts/${JOB}.md`, `${JOB}.launch`];
  const before = protectedFiles.map(path => readFileSync(join(options.runsDir, path), 'utf8'));
  const call = fakeCall();
  const responses: string[] = [];
  ps = `482 00:10 /fixture-private-path/bin/launch.sh ${OTHER} phantom devin work\n`;
  responses.push(await receive(call, 1));
  ps = `483 00:10 /fixture-private-path/bin/launch.sh ${JOB}-EXTRA phantom devin work\n`;
  responses.push(await receive(call, 2));
  ps = '';
  responses.push(await receive(call, 3));
  const posts = vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage').length;
  const inboxBeforeRedelivery = readFileSync(join(options.runsDir, 'leader/MASON-INBOX.md'), 'utf8');
  await receive(call, 3, true);
  expect(readFileSync(join(options.runsDir, 'leader/MASON-INBOX.md'), 'utf8')).toBe(inboxBeforeRedelivery);
  expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(posts);
  options.now = () => Date.parse('2026-11-14T19:31:00Z');
  ps = `484 00:10 /fixture-private-path/bin/launch.sh ${JOB} phantom devin work\n`;
  responses.push(await receive(call, 4));
  for (const text of responses.slice(0, 3)) {
    expect(orderLine(text)).not.toContain('· RUNNING ·');
    expect(orderLine(text)).toContain(`owner ${JOB}`);
  }
  expect(orderLine(responses[3]!)).toContain(`· RUNNING · owner ${JOB}`);
  expect(responses[3]).toContain('as of 14:31 ET');
  for (const text of responses) expect(text).not.toMatch(/Private synthetic order text|Fixture private|fixture-private-path|fixture-private-lease/);
  expect(protectedFiles.map(path => readFileSync(join(options.runsDir, path), 'utf8'))).toEqual(before);
});
