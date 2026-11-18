import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticePrev, readClaimNoticeSentRows,
  runClaimNoticePass, writeClaimNoticePrev } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';

const TEAM = 'T000FAKE', CHANNEL = 'C000FAKE', BOT = 'U000BOT', OWNER = 'U000OWNER';
const THREAD = '1794974400.000001', POST = '1794974401.000001';
let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it('delivers one honest RELEASED notice at a real lease boundary, with durable restart fencing', async () => {
  let now = Date.parse('2026-11-18T04:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  root = mkdtempSync(join(tmpdir(), 'fake-slack-expiry-576s-'));
  const configDir = join(root, 'config'), runsRoot = join(root, 'runs'), busRoot = join(root, 'bus');
  const ledger = join(root, 'coordination.jsonl'), stateRoot = join(root, 'transport');
  mkdirSync(configDir, { mode: 0o700 });
  const configPath = join(configDir, 'agent-network.toml');
  writeFileSync(configPath, `[team]\nidentities=[{channel="slack",id="${OWNER}"}]\n` +
    `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="${BOT}"\nown_bot_id="B000BOT"\n` +
    `[[slack.map]]\ntopic="fake-topic"\nchannel="${CHANNEL}"\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const claimed = claimFleetWork({ repo: 'fake/phantom', task: 'fake unfinished work',
    agent: 'fake-worker', ttlMs: 2_000 }, { path: ledger, now });
  if (!claimed.ok) throw new Error(`fixture claim failed: ${claimed.error}`);
  const { claim } = claimed.value;
  expect(claim.expiresAt).toBe(now + 2_000);
  const paths = claimNoticePaths(runsRoot), threadKey = `${TEAM}/${CHANNEL}/${THREAD}`;
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey }, now))
    .toMatchObject({ ok: true, status: 'bound' });
  // Rebuild the board reader, config reader, file deps and real bus sender on every invocation.
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, now: () => now,
    readConfig: () => loadAgentNetworkConfig({ path: configPath }),
    readBoard: () => readFleetBoard({ path: ledger, now }) }));
  const inbox = () => {
    const page = listBusInboxAfter(0, 100, { root: busRoot, now: () => now });
    if (page.status !== 'ok') throw new Error(`scratch bus unavailable: ${page.status}`);
    return page.messages;
  };
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0, failed: 0 });
  now = claim.expiresAt - 1;
  expect(readFleetBoard({ path: ledger, now })).toMatchObject({ state: 'known', claims: [claim], messages: [] });
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(inbox()).toEqual([]); // In particular, expiry cannot be announced one millisecond early.
  const liveSnapshot = readClaimNoticePrev(paths.prev);
  expect(liveSnapshot).toEqual({ state: 'known', claims: [claim], messages: [], asOf: now });
  if (!liveSnapshot) throw new Error('real live snapshot missing');
  const beforeExpiry = readFileSync(ledger, 'utf8');
  now = claim.expiresAt;
  // The public board reader owns the durable reap; the notification consumer does not.
  expect(readFleetBoard({ path: ledger, now })).toMatchObject({ state: 'known', claims: [],
    messages: [], proposals: [], expiredClaims: 1 });
  const afterExpiry = readFileSync(ledger, 'utf8');
  expect(afterExpiry.startsWith(beforeExpiry)).toBe(true);
  expect(afterExpiry.slice(beforeExpiry.length).trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { version: 1, kind: 'reap', at: now, id: claim.id, owner: claim.agent,
      state: 'RELEASED', reason: 'lease-expired' },
  ]);
  const produced = await pass();
  expect(produced).toMatchObject({ status: 'completed', baselined: false, planned: 1, sent: 1, failed: 0,
    deliveries: [{ state: 'RELEASED', threadKey, result: 'sent' }] });
  const rows = inbox();
  expect(rows).toHaveLength(1);
  const original = rows[0]!;
  expect(original.envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey, to: 'fake-topic',
    body: { kind: 'note', text: expect.stringContaining('RELEASED:'),
      thread: `slack:${TEAM}:${CHANNEL}:${THREAD}`, inReplyTo: produced.deliveries[0]!.dedupeKey } });
  // Producer 'sent' means enqueue only, independently of Slack delivery evidence.
  expect(produced.deliveries[0]!.receipt).toBe(`bus-note:${original.envelope.id}`);
  expect(readClaimNoticeSentRows(paths.sent)).toEqual([{ key: produced.deliveries[0]!.dedupeKey, at: now }]);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'missing', receipts: [] });
  const posts: Record<string, unknown>[] = [];
  const deliver = async () => {
    const policy = readSlackDeliveryPolicy({ configDir });
    if (!policy) throw new Error('scratch policy unavailable');
    const controller = new AbortController();
    // Only Slack's external API is replaced. All audience and communication gates run.
    const call: SlackCall = async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: TEAM, user_id: BOT, bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: body.channel, context_team_id: TEAM } };
      if (method === 'conversations.members') return { members: [BOT, OWNER] };
      if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === BOT } };
      if (method === 'chat.postMessage') {
        expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [
          { key: slackSendStoreKey(original.envelope.id), state: 'attempted', channel: CHANNEL, thread: THREAD },
        ] });
        posts.push(body);
        return { channel: body.channel, ts: POST };
      }
      throw new Error(`unexpected fake Slack method: ${method}`);
    };
    const pending = inbox(); // Restart the durable consumer from cursor zero.
    expect(pending).toEqual([original]);
    try {
      return await deliverSlackEnvelope(pending[0]!.envelope, { ...policy, call, stateRoot,
        runsDir: runsRoot, busRoot, signal: controller.signal,
        readPolicy: () => readSlackDeliveryPolicy({ configDir }) });
    } finally { controller.abort(); }
  };
  const coordinationBytes = readFileSync(ledger), bindingBytes = readFileSync(paths.bindings);
  const enqueueBytes = readFileSync(paths.sent);
  expect(await deliver()).toEqual({ status: 'sent', reason: 'delivery-proved', ts: POST });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD });
  expect(posts[0]!.text).toBe(`RELEASED: ${claim.agent} ${claim.repo}#?@unknown claim ${claim.id}; ` +
    `claim expired; as of ${new Date(claim.expiresAt).toISOString()}`);
  expect(JSON.stringify(posts)).not.toMatch(/VERIFIED|task complete|RESULT|leaseHash/i);
  expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [
    { key: slackSendStoreKey(original.envelope.id), state: 'sent', channel: CHANNEL, thread: THREAD, ts: POST },
  ] });
  expect(readFileSync(ledger)).toEqual(coordinationBytes);
  expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
  const transportBytes = readFileSync(join(stateRoot, 'messages.json'));
  // Restore only a genuine earlier snapshot, simulating a producer snapshot replay after restart.
  writeClaimNoticePrev(paths.prev, liveSnapshot);
  expect(await pass()).toMatchObject({ planned: 1, sent: 0, skipped: 1, failed: 0,
    deliveries: [{ state: 'RELEASED', result: 'ledgered' }] });
  expect(appendBusInbox(original.envelope, { root: busRoot, now: () => now }))
    .toMatchObject({ status: 'duplicate', id: original.envelope.id });
  expect(await deliver()).toEqual({ status: 'duplicate', reason: 'delivery-proved', ts: POST });
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(posts).toHaveLength(1);
  expect(inbox()).toEqual([original]); // No additional release envelope, even on producer replay.
  expect(readFileSync(paths.sent)).toEqual(enqueueBytes);
  expect(readFileSync(join(stateRoot, 'messages.json'))).toEqual(transportBytes);
  expect(readFleetBoard({ path: ledger, now })).toMatchObject({ state: 'known', claims: [], messages: [] });
  expect(readClaimNoticePrev(paths.prev)).toEqual({ state: 'known', claims: [], messages: [], asOf: now });
  expect(readFileSync(ledger)).toEqual(coordinationBytes); // No manufactured return receipt or work rewrite.
  expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
});
