import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';

const TEAM = 'T000FAKE', CHANNEL = 'C000FAKE', BOT = 'U000BOT', OWNER = 'U000OWNER';
const THREAD = '1794978000.000001', TS = '1794978001.000001';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([
  ['wrong channel', { channel: 'C000OTHER', ts: TS }],
  ['invalid timestamp', { channel: CHANNEL, ts: 'invalid' }],
])('keeps an ASSIGNED notice uncertain after a %s response until original-thread proof survives restart', async (_name, response) => {
  let now = Date.parse('2026-11-18T05:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const root = mkdtempSync(join(tmpdir(), 'slack-response-579s-'));
  chmodSync(root, 0o700); roots.push(root);
  const configDir = join(root, 'config'), runsRoot = join(root, 'runs'), busRoot = join(root, 'bus');
  const ledger = join(root, 'coordination.jsonl'), stateRoot = join(root, 'transport');
  mkdirSync(configDir, { mode: 0o700 });
  const configPath = join(configDir, 'agent-network.toml');
  writeFileSync(configPath, `[team]\nidentities=[{channel="slack",id="${OWNER}"}]\n` +
    `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="${BOT}"\nown_bot_id="B000BOT"\n` +
    `[[slack.map]]\ntopic="fake-assignments"\nchannel="${CHANNEL}"\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const board = () => readFleetBoard({ path: ledger, now });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, now: () => now,
    readConfig: () => loadAgentNetworkConfig({ path: configPath }), readBoard: board }));
  const advance = () => { now += 1_000; return { path: ledger, now }; };
  expect(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, advance()).ok).toBe(true);
  expect(await pass()).toMatchObject({ baselined: true, planned: 0, sent: 0 });
  const accepted = claimFleetWork({ repo: 'fake/phantom', task: 'synthetic assignment', agent: 'fake-agent' }, advance());
  if (!accepted.ok) throw new Error(`scratch claim failed: ${accepted.error}`);
  const { claim } = accepted.value, paths = claimNoticePaths(runsRoot);
  const threadKey = `${TEAM}/${CHANNEL}/${THREAD}`;
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey }, now))
    .toMatchObject({ ok: true, status: 'bound' });
  const ledgerBytes = readFileSync(ledger), bindingBytes = readFileSync(paths.bindings), before = board();
  expect(before).toMatchObject({ state: 'known', claims: [claim], proposals: [], messages: [] });
  const produced = await pass();
  expect(produced).toMatchObject({ planned: 1, sent: 1, failed: 0, deliveries: [{ state: 'ASSIGNED' }] });
  const inbox = () => scanBusInbox({ root: busRoot, now: () => now });
  const original = inbox();
  expect(original).toMatchObject({ source: 'available', skipped: 0 });
  expect(original.rows).toHaveLength(1);
  const envelope = original.rows[0]!.envelope, key = slackSendStoreKey(envelope.id);
  expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey, body: { kind: 'note' } });
  expect(JSON.stringify(envelope.body)).toContain('ASSIGNED');
  expect(JSON.stringify(envelope.body)).not.toContain('VERIFIED');
  expect(produced.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
  const enqueueCount = produced.sent, producerBytes = readFileSync(paths.sent);
  const posts: Record<string, unknown>[] = [], histories: Record<string, unknown>[] = [];
  let physicalPostCount = 0;
  const attempted = { state: 'ok', receipts: [{ key, state: 'attempted', channel: CHANNEL, thread: THREAD }] };
  const drain = async (messages: Record<string, unknown>[]) => {
    // Reconstruct policy, envelope and adapter for every consumer restart; only scratch disk survives.
    const policy = readSlackDeliveryPolicy({ configDir });
    if (!policy) throw new Error('scratch policy unavailable');
    const replay = inbox();
    expect(replay.rows).toEqual(original.rows);
    const call: SlackCall = async (method, input = {}) => {
      if (method === 'auth.test') return { team_id: TEAM, user_id: BOT, bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: input.channel, context_team_id: TEAM } };
      if (method === 'conversations.members') return { members: [BOT, OWNER] };
      if (method === 'users.info') return { user: { id: input.user, team_id: TEAM, is_bot: input.user === BOT } };
      if (method === 'chat.postMessage') {
        physicalPostCount++; posts.push(structuredClone(input));
        expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
        return response;
      }
      if (method === 'conversations.replies') {
        histories.push(structuredClone(input));
        expect(input).toEqual({ channel: CHANNEL, ts: THREAD, limit: 100 });
        return { messages, has_more: false, response_metadata: { next_cursor: '' } };
      }
      throw new Error(`unexpected synthetic Slack method: ${method}`);
    };
    return deliverSlackEnvelope(replay.rows[0]!.envelope, { ...policy, call, stateRoot, runsDir: runsRoot, busRoot,
      readPolicy: () => readSlackDeliveryPolicy({ configDir }) });
  };
  expect(readSlackSendReceipts({ stateRoot }).receipts).toEqual([]);
  expect({ enqueueCount, physicalPostCount }).toEqual({ enqueueCount: 1, physicalPostCount: 0 });
  expect(await drain([])).toEqual({ status: 'uncertain', reason: 'delivery-response-unproved' });
  expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD, client_msg_id: expect.any(String) });
  expect(posts[0]!.client_msg_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(posts[0])).toContain('ASSIGNED');
  expect(JSON.stringify(posts[0])).not.toContain('VERIFIED');
  const intentBytes = readFileSync(join(stateRoot, 'messages.json'));
  const intent = JSON.parse(intentBytes.toString()).messages[key];
  expect(intent).toMatchObject({ clientId: posts[0]!.client_msg_id, channel: CHANNEL, thread: THREAD, state: 'attempted' });
  advance();
  expect(await drain([])).toEqual({ status: 'uncertain', reason: 'delivery-needs-reconciliation' });
  expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
  expect(readFileSync(join(stateRoot, 'messages.json'))).toEqual(intentBytes);
  expect(physicalPostCount).toBe(1);
  expect(histories).toEqual([{ channel: CHANNEL, ts: THREAD, limit: 100 }]);
  advance();
  expect(await drain([{ client_msg_id: posts[0]!.client_msg_id, user: BOT, thread_ts: THREAD, ts: TS }]))
    .toEqual({ status: 'sent', reason: 'delivery-reconciled', ts: TS });
  const sent = { state: 'ok', receipts: [{ key, state: 'sent', channel: CHANNEL, thread: THREAD, ts: TS }] };
  expect(readSlackSendReceipts({ stateRoot })).toEqual(sent);
  const sentBytes = readFileSync(join(stateRoot, 'messages.json'));
  advance();
  expect(await drain([])).toEqual({ status: 'duplicate', reason: 'delivery-proved', ts: TS });
  expect(readSlackSendReceipts({ stateRoot })).toEqual(sent);
  expect(readFileSync(join(stateRoot, 'messages.json'))).toEqual(sentBytes);
  expect(histories).toEqual(Array.from({ length: 2 }, () => ({ channel: CHANNEL, ts: THREAD, limit: 100 })));
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0, deliveries: [] });
  expect(inbox().rows).toEqual(original.rows);
  expect(readFileSync(paths.sent)).toEqual(producerBytes);
  expect(readFileSync(ledger)).toEqual(ledgerBytes);
  expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
  expect(board()).toEqual(before); // assignment, proposals and results remain untouched
  expect({ enqueueCount, physicalPostCount }).toEqual({ enqueueCount: 1, physicalPostCount: 1 });
  expect(posts).toHaveLength(1);
});
