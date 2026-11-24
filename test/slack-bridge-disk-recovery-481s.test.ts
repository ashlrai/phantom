/** RQ-PHX-BRIDGESLACKDISK481S: same-thread bridge recheck across a real
 * coordination-ledger outage and repair through the production Slack
 * socket -> adapter -> ownerStatusReply -> readFleetBridgeCheck ->
 * formatBridgeCheckReply -> journaled delivery. Fakes stop at the Slack
 * API, process table and host labels; claims use the real ledger reader
 * and repair via the real claimFleetWork writer. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import { readFleetRuntime } from '../src/mcp/fleet-runtime.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

vi.setConfig({ testTimeout: 30_000 }); const WAIT_MS = 15_000, T0 = Date.parse('2026-11-15T00:00:00.000Z');
const FOOTER = 'Reachability only; this is not an assignment or claim.', iso = (ms: number) => new Date(ms).toISOString();
const OPERATOR = 'U000TEST', CHANNEL = 'D000TEST', TEAM = 'T0FAKETEAM', THREAD_TS = '1793920000.000001', POST_TS = '1793920002.000001';
const configText = `[mason]\nidentities=[{channel="slack",id="${OPERATOR}"}]\n[team]\nidentities=[{channel="slack",id="${OPERATOR}"},{channel="slack",id="U0FAKEPEER"}]\n` +
  `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`;

let root: string, now: number, ledger: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };

// Real runtime snapshot over temp files; only OS seams (host labels, process table, tailnet) are synthetic.
const runtimeDeps = (): FleetRuntimeDeps => ({
  now: () => now, home: () => root, host: () => 'fake-host-481s', platform: () => 'fakeos', arch: () => 'fakearch',
  pid: () => 4812, uptime: () => 120, stateRoot: () => join(root, 'fleet-state'),
  installedVersion: () => '9.9.9', sourceVersion: () => '9.9.9', tailnet: () => 'fake-tail-481s', board: readFleetBoard,
  execution: () => readClaimExecution({ now: () => now, workers: async () => ({ v: 1, generatedAt: iso(now),
    sourceState: 'healthy' as const, workers: [], leaders: [], orchestratorAgents: 0 }) }) });

const composer = () => ownerStatusReply({ bridge: async at => formatBridgeCheckReply(await readFleetBridgeCheck({
  now: () => at.getTime(), runtime: () => readFleetRuntime(runtimeDeps()), peers: () => ({ status: 'ok' }) }), at) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-disk-481s-')); now = T0;
  const configDir = join(root, 'config'); mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(join(configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  ledger = join(root, 'coordination.jsonl'); const stateFile = join(root, 'fleet-state', 'state.json');
  mkdirSync(join(root, 'fleet-state'), { mode: 0o700 }); writeFileSync(stateFile, '{}', { mode: 0o600 });
  utimesSync(stateFile, new Date(T0 - 30_000), new Date(T0 - 30_000));
  options = { configDir, runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => now };
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger); vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', OPERATOR], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: POST_TS };
    throw new Error('unexpected-synthetic-method');
  });
}
const postBody = (call: SlackCall, index: number) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')[index]?.[1] as { channel: string; thread_ts: string; text: string };

function sentReceipts() {
  const store = JSON.parse(readFileSync(join(options.runsDir, 'slack-transport', 'messages.json'), 'utf8')) as { messages: Record<string, { state: string; channel: string; thread?: string; ts?: string }> };
  return Object.values(store.messages).filter(row => row.state === 'sent');
}
const slackEvent = (eventId: string, ts: string) => ({ type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: TEAM, event_id: eventId, event: {
  type: 'message', user: OPERATOR, channel: CHANNEL, ts, thread_ts: THREAD_TS, text: 'bridge?' } } });

/** Fresh adapter + socket per ask; awaits the detached in-thread answer. */
async function receive(call: SlackCall, payload: unknown) {
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: composer() });
  let routed: { owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> } | undefined;
  let settled = false;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return routed = await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
  return { routed, answer: routed?.statusAnswer ? await routed.statusAnswer : undefined, socket };
}

it('answers BLOCKED on a corrupt claims ledger, then READY with fresh claims on the same thread after real repair', async () => {
  const call = fakeCall();
  writeFileSync(ledger, 'private-corrupt-481s\n', { mode: 0o600 });
  now = T0 + 10_000; const corruptBytes = readFileSync(ledger);
  const blocked = await receive(call, slackEvent('Ev-481s-a', '1793920001.000001'));
  expect(readFileSync(ledger)).toEqual(corruptBytes);
  expect(blocked.routed).toMatchObject({ owned: true, durable: true });
  expect(blocked.answer).toEqual({ answered: true, reason: 'answered in-thread' });
  const bad = postBody(call, 0); expect(bad).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
  expect(bad.text).toBe(`Leader: Bridge: BLOCKED as of ${iso(now)} · missing runtime.coordination, runtime.execution, claims\n` +
    `Runtime: ok · fleet-state age 40s · host fake-host-481s · stateRoot ~/fleet-state\nClaims: unknown\nPeers: ok\n${FOOTER}`);
  for (const leak of ['private-corrupt-481s', 'ASSIGNED', 'RUNNING', 'VERIFIED']) expect(bad.text).not.toContain(leak);
  expect(sentReceipts()).toEqual([expect.objectContaining({ channel: CHANNEL, thread: THREAD_TS, ts: POST_TS })]);

  writeFileSync(ledger, '', { mode: 0o600 });
  expect(claimFleetWork({ repo: 'example/repo', task: 'disk-recovery-probe-481s', agent: 'dot-481s', ttlMs: 60_000 }, { now: T0 + 20_000 }))
    .toMatchObject({ ok: true });
  now = T0 + 25_000; const healedBytes = readFileSync(ledger);
  const ready = await receive(call, slackEvent('Ev-481s-b', '1793920003.000001'));
  expect(readFileSync(ledger)).toEqual(healedBytes);
  expect(ready.routed).toMatchObject({ owned: true, durable: true });
  expect(ready.answer).toEqual({ answered: true, reason: 'answered in-thread' });
  const good = postBody(call, 1); expect(good).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
  expect(good.text).toBe(`Leader: Bridge: READY as of ${iso(now)}\n` +
    `Runtime: ok · fleet-state age 55s · host fake-host-481s · stateRoot ~/fleet-state\nClaims: 1 live, newest 5s\nPeers: ok\n${FOOTER}`);
  for (const leak of ['dot-481s', 'disk-recovery-probe-481s', 'ASSIGNED', 'VERIFIED']) expect(good.text).not.toContain(leak);
  const receipt = expect.objectContaining({ channel: CHANNEL, thread: THREAD_TS, ts: POST_TS });
  expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(2); expect(sentReceipts()).toEqual([receipt, receipt]);
  const outbox = readFileSync(join(options.runsDir, 'leader', 'MASON-OUTBOX.md'), 'utf8');
  for (const line of ['Bridge: BLOCKED', 'Claims: 1 live, newest 5s']) expect(outbox).toContain(line);
});
