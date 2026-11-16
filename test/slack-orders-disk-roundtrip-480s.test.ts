/** Orders through the durable socket/inbox/reply path; only external transport
 * and process observations are fake. No composed answer or trace is injected. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const JOB = 'RQ-FAKE-ORDERS480', OTHER = 'RQ-FAKE-UNRELATED480';
const AT = '2026-11-14 12:00';
let root: string, ps: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const disk = (path: string, text: string) => writeFileSync(join(options.runsDir, path), text, { mode: 0o600 });
const metric = (row: Record<string, unknown>) => appendFileSync(join(options.runsDir, 'metrics/jobs.jsonl'), JSON.stringify(row) + '\n');
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

async function receive(call: SlackCall, index: number, text = 'orders') {
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
    team_id: TEAM, event_id: `Ev-orders-${index}`, event: { type: 'message', user: USER, channel: CHANNEL, ts: thread, thread_ts: thread, text },
  } }) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 15_000 });
  expect(routed).toMatchObject({ owned: true, durable: true });
  if (text !== 'orders') {
    expect(readFileSync(join(options.runsDir, 'leader/MASON-INBOX.md'), 'utf8')).toContain(text);
    return '';
  }
  expect(await routed?.statusAnswer).toEqual({ answered: true, reason: 'answered in-thread' });
  const body = vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage').at(-1)?.[1] as { text: string };
  expect(body).toMatchObject({ channel: CHANNEL, thread_ts: thread });
  expect(body.text).toMatch(/^Leader: Phantom orders, as of 14:30 ET \(order-trace\)\n/);
  expect(readFileSync(join(options.runsDir, 'leader/MASON-OUTBOX.md'), 'utf8')).toContain(body.text.replace(/^Leader: /, ''));
  // Socket ack alone never proves delivery: require the transport's persisted
  // sent receipt for this exact request channel/thread after adapter recreation.
  const store = JSON.parse(readFileSync(join(options.runsDir, 'slack-transport/messages.json'), 'utf8')) as { messages: Record<string, unknown> };
  expect(Object.values(store.messages)).toContainEqual(expect.objectContaining({ state: 'sent', channel: CHANNEL, thread, ts: '1794684602.000001' }));
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: `Ev-orders-${index}-delivery` })), { timeout: 15_000 });
  return body.text;
}

it('preserves received, queued, running, published and verified disk evidence across fresh Slack asks', async () => {
  const call = fakeCall();
  options.now = () => Date.parse('2026-11-14T17:00:00Z');
  await receive(call, 0, 'Synthetic new request without a bound job');
  options.now = () => Date.parse('2026-11-14T19:30:00Z');
  let text = await receive(call, 1);
  expect(orderLine(text)).toBe(`${AT} · slack · RECEIVED · no owner · no PR · missing: named owner, durable claim receipt`);
  expect(text).not.toMatch(/· (ASSIGNED|RUNNING|VERIFIED) ·/);
  disk(`queue/prompts/${JOB}.md`, "Serves Mason's Nov 14 12:00 order.\n");
  disk('queue/ready.tsv', `status\tid\tpool\ttier\trepo\ttitle\nREADY\t${JOB}\tdevin\twork\tphantom\tSynthetic work\n`);
  text = await receive(call, 2);
  expect(orderLine(text)).toBe(`${AT} · slack · RECEIVED · owner ${JOB} (devin) · no PR · missing: durable claim receipt`);
  disk(`${JOB}.launch`, `launched ${JOB} devin pid 480 base fake\n`);
  ps = `480 00:10 /synthetic/bin/launch.sh ${JOB} phantom devin work\n`;
  text = await receive(call, 3);
  expect(orderLine(text)).toBe(`${AT} · slack · RUNNING · owner ${JOB} (devin) · no PR · missing: none`);
  ps = '';
  metric({ event: 'publish', job: JOB, url: 'https://github.com/ashlrai/phantom/pull/9480', ts: '2026-11-14T19:30:00Z' });
  text = await receive(call, 4);
  expect(orderLine(text)).toBe(`${AT} · slack · ASSIGNED · owner ${JOB} (devin) · PR #9480 · missing: none`);
  metric({ event: 'outcome', job: JOB, state: 'MERGED', ts: '2026-11-14T19:30:00Z' });
  text = await receive(call, 5);
  expect(orderLine(text)).toBe(`${AT} · slack · VERIFIED · owner ${JOB} (devin) · PR #9480 · missing: none`);
  disk('queue/slots.json', '{"lanes":"invalid"}');
  text = await receive(call, 6);
  expect(text).toContain('BLOCKED not checked (lane holds unavailable)');
});

it('never borrows a same-minute unrelated order job or PR', async () => {
  disk('leader/MASON-INBOX.md', `## ${AT} ET (Mason, slack) PRIORITY P0\nSynthetic requested work.\n`);
  appendFileSync(join(options.runsDir, 'leader/MASON-INBOX.md'), `## ${AT} ET (Mason, desktop) PRIORITY P0\nUnrelated synthetic request.\n`);
  disk(`queue/prompts/${OTHER}.md`, "Serves Mason's Nov 14 12:00 unrelated desktop order.\n");
  disk(`${OTHER}.launch`, `launched ${OTHER} devin pid 481 base fake\n`);
  metric({ event: 'merged', job: OTHER, url: 'https://github.com/ashlrai/phantom/pull/9481', ts: '2026-11-14T19:30:00Z' });
  const text = await receive(fakeCall(), 1);
  expect(text).toContain(`${AT} · desktop · VERIFIED · owner ${OTHER} (devin) · PR #9481 · missing: none`);
  expect(orderLine(text)).toBe(`${AT} · slack · RECEIVED · no owner · no PR · missing: named owner, durable claim receipt`);
});
