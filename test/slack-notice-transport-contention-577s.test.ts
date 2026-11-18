import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig, SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('posts one durable ASSIGNED notice when two drain workers contend and a fresh worker replays it', async () => {
  vi.useFakeTimers();
  let now = Date.parse('2026-11-18T00:00:00Z');
  vi.setSystemTime(now);
  const dir = mkdtempSync(join(tmpdir(), 'slack-notice-577s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs');
  const busRoot = join(dir, 'bus'), stateRoot = join(dir, 'transport');
  const teamId = 'T000FAKE', channel = 'C000FAKE', thread = '1700000000.000001', ts = '1700000000.000002';
  const threadKey = `${teamId}/${channel}/${thread}`;
  const config: SlackBridgeConfig = { bridgeId: 'slack', teamId, ownUserId: 'U000BOT', ownBotId: 'B000BOT',
    map: [{ topic: 'fake-topic', channel }] };
  const teamIdentities = [{ channel: 'slack' as const, id: 'U000OWNER' }];
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, now: () => now,
    readBoard: () => readFleetBoard({ path: ledger, now }) }));
  const advance = () => { now += 1_000; vi.setSystemTime(now); return { path: ledger, now }; };
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, advance()));
  expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
  const claim = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task', agent: 'fake-agent' }, advance())).claim;
  expect(appendClaimThreadBinding(claimNoticePaths(runsRoot).bindings,
    { claimId: claim.id, repo: claim.repo, threadKey }, now).ok).toBe(true);
  const notice = await pass();
  expect(notice).toMatchObject({ planned: 1, sent: 1, failed: 0, deliveries: [{ state: 'ASSIGNED' }] });
  const scan = () => scanBusInbox({ root: busRoot, now: () => now });
  const inbox = scan();
  expect(inbox).toMatchObject({ source: 'available', skipped: 0 });
  expect(inbox.rows).toHaveLength(1);
  const envelope = inbox.rows[0]!.envelope;
  expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey, body: { kind: 'note' } });
  expect(JSON.stringify(envelope.body)).toContain('ASSIGNED');
  expect(JSON.stringify(envelope.body)).not.toContain('VERIFIED');
  expect(notice.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
  expect(readSlackSendReceipts({ stateRoot }).receipts).toEqual([]);
  const boardBefore = readFleetBoard({ path: ledger, now });
  expect(boardBefore).toMatchObject({ state: 'known', claims: [claim], proposals: [] });
  const ledgerBefore = readFileSync(ledger, 'utf8');
  const entered = deferred<Record<string, unknown>>(), release = deferred<Record<string, unknown>>();
  const posts: Record<string, unknown>[] = [];
  const call: SlackCall = async (method, input = {}) => {
    if (method === 'auth.test') return { team_id: teamId, user_id: 'U000BOT', bot_id: 'B000BOT' };
    if (method === 'conversations.info') return { channel: { id: input.channel, is_channel: true, context_team_id: teamId } };
    if (method === 'conversations.members') return { members: ['U000BOT', 'U000OWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: input.user, team_id: teamId, is_bot: input.user === 'U000BOT' } };
    if (method === 'chat.postMessage') {
      posts.push(input); entered.resolve(input);
      return release.promise;
    }
    throw new Error(`unexpected method ${method}`);
  };
  // Each worker gets fresh inputs, sharing only the real durable state and bus row.
  const inputs = (workerCall: SlackCall) => ({ config: structuredClone(config), teamIdentities: structuredClone(teamIdentities),
    confirmedByMason: true, stateRoot, runsDir: runsRoot, busRoot, call: workerCall });
  const first = deliverSlackEnvelope(envelope, inputs(call));
  try {
    // Fail promptly if delivery exits before reaching the post; no timer or sleep is needed.
    const posted = await Promise.race([entered.promise, first.then(result => {
      throw new Error(`first worker exited before post: ${JSON.stringify(result)}`);
    })]);
    expect(posted).toMatchObject({ channel, thread_ts: thread });
    expect(JSON.stringify(posted)).toContain('ASSIGNED');
    expect(JSON.stringify(posted)).not.toContain('VERIFIED');
    const attempted = { state: 'ok', receipts: [{ key: slackSendStoreKey(envelope.id), state: 'attempted', channel, thread }] };
    expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
    const competitor = vi.fn<SlackCall>(call);
    expect(await deliverSlackEnvelope(envelope, inputs(competitor))).toEqual({ status: 'refused', reason: 'delivery-claimed' });
    expect(competitor).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
    release.resolve({ ok: true, channel, ts });
    expect(await first).toEqual({ status: 'sent', reason: 'delivery-proved', ts });
    const sent = { state: 'ok', receipts: [{ key: slackSendStoreKey(envelope.id), state: 'sent', channel, thread, ts }] };
    expect(readSlackSendReceipts({ stateRoot })).toEqual(sent);
    const replayRow = scan().rows[0]!;
    expect(replayRow).toEqual(inbox.rows[0]);
    const replay = vi.fn<SlackCall>(call);
    expect(await deliverSlackEnvelope(replayRow.envelope, inputs(replay))).toEqual({ status: 'duplicate', reason: 'delivery-proved', ts });
    expect(replay.mock.calls.map(([method]) => method)).toEqual(['auth.test']);
    expect(readSlackSendReceipts({ stateRoot })).toEqual(sent);
    advance();
    expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0, deliveries: [] });
    expect(scan().rows).toEqual(inbox.rows);
    expect(readFleetBoard({ path: ledger, now })).toEqual(boardBefore);
    expect(readFileSync(ledger, 'utf8')).toBe(ledgerBefore);
    expect(posts).toHaveLength(1);
  } finally {
    // Settle both barriers even on assertion failure, then let the lock owner finish before removing scratch state.
    entered.resolve({}); release.resolve({ ok: true, channel, ts });
    await first;
  }
});
