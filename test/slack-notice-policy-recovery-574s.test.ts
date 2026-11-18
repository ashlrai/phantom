import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';

const NOW = Date.parse('2026-11-18T04:00:00Z');
const TEAM = 'T000FAKE', CHANNEL = 'C000FAKE', BOT = 'U000BOT', OWNER = 'U000OWNER';
const THREAD = '1794974400.000001', OTHER_THREAD = '1794974400.000099', POST = '1794974401.000001';
let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it('replays a durable ASSIGNED notice after a definite policy refusal, once in its source thread', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW); // claim, bus TTL and transport retention share one valid clock
  root = mkdtempSync(join(tmpdir(), 'fake-slack-policy-574s-'));
  const configDir = join(root, 'config'), runsRoot = join(root, 'runs'), busRoot = join(root, 'bus');
  const ledger = join(root, 'coordination.jsonl'), stateRoot = join(runsRoot, 'slack-transport');
  mkdirSync(configDir, { mode: 0o700 });
  const configPath = join(configDir, 'agent-network.toml'), commsPath = join(configDir, 'comms.toml');
  writeFileSync(configPath, `[team]\nidentities=[{channel="slack",id="${OWNER}"}]\n` +
    `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="${BOT}"\nown_bot_id="B000BOT"\n` +
    `[[slack.map]]\ntopic="fake-topic"\nchannel="${CHANNEL}"\n`, { mode: 0o600 });
  const approval = (confirmed: boolean) => writeFileSync(commsPath, `confirmedByMason=${confirmed}\n`, { mode: 0o600 });
  approval(false);
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, now: () => NOW,
    readConfig: () => loadAgentNetworkConfig({ path: configPath }),
    readBoard: () => readFleetBoard({ path: ledger, now: NOW }) }));
  expect(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'fake baseline', ttlMs: 1 },
    { path: ledger, now: NOW - 2 }).ok).toBe(true);
  expect(await pass()).toMatchObject({ baselined: true, planned: 0, sent: 0 });
  const claimed = claimFleetWork({ repo: 'fake/phantom', task: 'fake assignment', agent: 'fake-owner' },
    { path: ledger, now: NOW });
  if (!claimed.ok) throw new Error(`fixture claim failed: ${claimed.error}`);
  expect(claimed.value.claim.expiresAt).toBeGreaterThan(NOW);
  const paths = claimNoticePaths(runsRoot);
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claimed.value.claim.id, repo: 'fake/phantom',
    threadKey: `${TEAM}/${CHANNEL}/${THREAD}` }, NOW)).toMatchObject({ ok: true, status: 'bound' });
  const claimBytes = readFileSync(ledger), bindingBytes = readFileSync(paths.bindings);
  const enqueued = await pass();
  expect(enqueued).toMatchObject({ planned: 1, sent: 1, failed: 0,
    deliveries: [{ state: 'ASSIGNED', result: 'sent' }] });
  const pending = () => {
    const page = listBusInboxAfter(0, 100, { root: busRoot, now: () => NOW });
    if (page.status !== 'ok') throw new Error(`scratch bus unavailable: ${page.status}`);
    expect(page.messages).toHaveLength(1);
    return page.messages[0]!;
  };
  const original = pending();
  expect(original.envelope.ttl).toBeGreaterThan(0);
  expect(original.envelope.channel_ref).toBe(`${TEAM}/${CHANNEL}/${THREAD}`);
  expect(enqueued.deliveries[0]!.receipt).toBe(`bus-note:${original.envelope.id}`);
  expect(readClaimNoticeSentRows(paths.sent)).toEqual([{ key: enqueued.deliveries[0]!.dedupeKey, at: NOW }]);
  const enqueueLedger = readFileSync(paths.sent);
  const posts: Record<string, unknown>[] = [];
  // Recreate the session's policy, AbortController, external call and bus reader.
  // channels-slack run starts its cursor at zero; refusal does not delete the envelope.
  const restartAndDrain = async () => {
    const policy = readSlackDeliveryPolicy({ configDir });
    if (!policy) throw new Error('scratch policy unavailable');
    const controller = new AbortController();
    const call: SlackCall = async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: TEAM, user_id: BOT, bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: body.channel, context_team_id: TEAM } };
      if (method === 'conversations.members') return { members: [BOT, OWNER] };
      if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === BOT } };
      if (method === 'chat.postMessage') { posts.push(body); return { channel: body.channel, ts: POST }; }
      throw new Error(`unexpected fake Slack method: ${method}`);
    };
    const row = pending();
    expect(row).toEqual(original); // same id, body, destination, TTL and durable cursor
    try {
      return await deliverSlackEnvelope(row.envelope, { ...policy, call, stateRoot, runsDir: runsRoot, busRoot,
        signal: controller.signal, readPolicy: () => readSlackDeliveryPolicy({ configDir }) });
    } finally { controller.abort(); }
  };
  const receipts = () => existsSync(join(stateRoot, 'messages.json'))
    ? Object.values(JSON.parse(readFileSync(join(stateRoot, 'messages.json'), 'utf8')).messages) : [];
  expect(await restartAndDrain()).toEqual({ status: 'refused', reason: 'communication-not-approved' });
  expect(posts).toHaveLength(0);
  expect(receipts()).toEqual([]); // no attempted or sent transport receipt; bus-note proves enqueue only
  expect(pending()).toEqual(original);
  approval(true); // restore the existing policy solely in scratch configuration
  expect(await restartAndDrain()).toEqual({ status: 'sent', reason: 'delivery-proved', ts: POST });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD });
  expect(receipts()).toEqual([expect.objectContaining({ state: 'sent', channel: CHANNEL, thread: THREAD, ts: POST })]);
  const proved = readFileSync(join(stateRoot, 'messages.json'));
  expect(await restartAndDrain()).toEqual({ status: 'duplicate', reason: 'delivery-proved', ts: POST });
  expect(posts).toHaveLength(1);
  expect(posts.some(body => body.thread_ts === OTHER_THREAD || body.thread_ts !== THREAD)).toBe(false);
  expect(readFileSync(join(stateRoot, 'messages.json'))).toEqual(proved);
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(readFileSync(paths.sent)).toEqual(enqueueLedger);
  expect(readFileSync(ledger)).toEqual(claimBytes);
  expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
  expect(readFleetBoard({ path: ledger, now: NOW }).claims).toEqual([claimed.value.claim]);
  expect(pending()).toEqual(original);
});
