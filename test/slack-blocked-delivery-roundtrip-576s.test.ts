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
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const NOW = Date.parse('2026-11-18T05:00:00Z');
const TEAM = 'T000FAKE', CHANNEL = 'C000FAKE', BOT = 'U000BOT', OWNER = 'U000OWNER';
const THREAD = '1794978000.000001', POST = '1794978001.000001';
let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it('delivers a lease-backed BLOCKED return once through the durable bus and source-thread transport after restart', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW); // lease, snapshots, bus TTL and transport retention agree
  root = mkdtempSync(join(tmpdir(), 'fake-slack-blocked-576s-'));
  chmodSync(root, 0o700);
  const configDir = join(root, 'config'), runsRoot = join(root, 'runs'), busRoot = join(root, 'bus');
  const ledger = join(root, 'coordination.jsonl'), stateRoot = join(root, 'transport');
  mkdirSync(configDir, { mode: 0o700 });
  const configPath = join(configDir, 'agent-network.toml');
  writeFileSync(configPath, `[team]\nidentities=[{channel="slack",id="${OWNER}"}]\n` +
    `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="${BOT}"\nown_bot_id="B000BOT"\n` +
    `[[slack.map]]\ntopic="fake-blockers"\nchannel="${CHANNEL}"\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const board = () => readFleetBoard({ path: ledger, now: NOW });
  // Every invocation rebuilds the production dependencies; state survives only in scratch files.
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, now: () => NOW,
    readConfig: () => loadAgentNetworkConfig({ path: configPath }), readBoard: board }));
  const claimed = claimFleetWork({ repo: 'fake/phantom', task: 'fake dependency qualification', agent: 'fake-owner' },
    { path: ledger, now: NOW });
  if (!claimed.ok) throw new Error(`scratch claim failed: ${claimed.error}`);
  const { claim, lease } = claimed.value;
  expect(claim.expiresAt).toBeGreaterThan(NOW);
  const paths = claimNoticePaths(runsRoot), threadKey = `${TEAM}/${CHANNEL}/${THREAD}`;
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey }, NOW))
    .toMatchObject({ ok: true, status: 'bound' });
  expect(await pass()).toMatchObject({ baselined: true, planned: 0, sent: 0, failed: 0 });
  const inbox = () => {
    const page = listBusInboxAfter(0, 100, { root: busRoot, now: () => NOW });
    if (page.status !== 'ok') throw new Error(`scratch bus unavailable: ${page.status}`);
    return page;
  };
  const input = { id: claim.id, agent: claim.agent, lease, blocked: 'fake schema-owner approval for dependency D576' };
  const returnClaim = () => returnFleetClaim(input, { path: ledger, now: NOW });
  const liveBytes = readFileSync(ledger), bindingBytes = readFileSync(paths.bindings);
  expect(returnFleetClaim({ ...input, lease: `${lease}-wrong` }, { path: ledger, now: NOW }))
    .toMatchObject({ ok: false, outcome: 'not-owner' });
  expect(readFileSync(ledger)).toEqual(liveBytes);
  expect(board().claims).toEqual([claim]);
  expect(board().messages).toEqual([]);
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(inbox().messages).toEqual([]); // wrong lease cannot manufacture a blocker envelope

  const returned = returnClaim();
  expect(returned).toMatchObject({ ok: true, outcome: 'returned', message: { from: claim.agent } });
  expect(board().claims).toEqual([]);
  expect(board().messages).toEqual([returned.message]);
  const returnBytes = readFileSync(ledger);
  const enqueued = await pass();
  expect(enqueued).toMatchObject({ planned: 1, sent: 1, failed: 0,
    deliveries: [{ state: 'BLOCKED', threadKey, result: 'sent' }] });
  expect(inbox().messages).toHaveLength(1);
  const original = inbox(), envelope = original.messages[0]!.envelope;
  expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey,
    body: { kind: 'note', thread: `slack:${TEAM}:${CHANNEL}:${THREAD}`, text: enqueued.deliveries[0]!.text } });
  expect(enqueued.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
  expect(readClaimNoticeSentRows(paths.sent)).toEqual([{ key: enqueued.deliveries[0]!.dedupeKey, at: NOW }]);
  const sentBytes = readFileSync(paths.sent);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'missing', receipts: [] });
  const posts: Record<string, unknown>[] = [];
  // Rebuild policy, API adapter, AbortController and bus read as a new consumer session would.
  const drain = async () => {
    const policy = readSlackDeliveryPolicy({ configDir });
    if (!policy) throw new Error('scratch delivery policy unavailable');
    const controller = new AbortController();
    const call: SlackCall = async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: TEAM, user_id: BOT, bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: body.channel, context_team_id: TEAM } };
      if (method === 'conversations.members') return { members: [BOT, OWNER] };
      if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === BOT } };
      if (method === 'chat.postMessage') {
        expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [{
          key: slackSendStoreKey(envelope.id), state: 'attempted', channel: CHANNEL, thread: THREAD }] });
        posts.push(body);
        return { channel: body.channel, ts: POST };
      }
      throw new Error(`unexpected fake Slack method: ${method}`);
    };
    const replay = inbox();
    expect(replay).toEqual(original);
    try {
      return await deliverSlackEnvelope(replay.messages[0]!.envelope, { ...policy, call, stateRoot,
        runsDir: runsRoot, busRoot, signal: controller.signal,
        readPolicy: () => readSlackDeliveryPolicy({ configDir }) });
    } finally { controller.abort(); }
  };
  expect(posts).toHaveLength(0); // bus-note and producer sent ledger establish enqueue, never Slack delivery
  expect(await drain()).toEqual({ status: 'sent', reason: 'delivery-proved', ts: POST });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD });
  for (const text of ['BLOCKED', claim.agent, claim.repo, claim.id, input.blocked, `as of ${new Date(NOW).toISOString()}`]) {
    expect(posts[0]!.text).toContain(text);
  }
  expect(posts[0]!.text).not.toMatch(/RELEASED|VERIFIED|ASSIGNED/);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [{
    key: slackSendStoreKey(envelope.id), state: 'sent', channel: CHANNEL, thread: THREAD, ts: POST }] });
  const transportBytes = readFileSync(join(stateRoot, 'messages.json'));
  expect(returnClaim()).toMatchObject({ ok: true, outcome: 'already-returned', message: returned.message });
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(await drain()).toEqual({ status: 'duplicate', reason: 'delivery-proved', ts: POST });
  expect(posts).toHaveLength(1);
  expect(inbox()).toEqual(original); // no second envelope, even after producer and consumer restart/replay
  expect(readFileSync(paths.sent)).toEqual(sentBytes);
  expect(readFileSync(join(stateRoot, 'messages.json'))).toEqual(transportBytes);
  expect(readFileSync(ledger)).toEqual(returnBytes);
  expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
  expect(board().claims).toEqual([]);
  expect(board().messages).toEqual([returned.message]);
});
