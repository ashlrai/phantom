import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { createSlackNoticeHealth } from '../src/cli/slack-notice-health.js';
import type { AgentNetworkConfig, SlackMapEntry } from '../src/core/agents/slack-network.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass,
  type ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('qualifies partial-notice health across a real bus enqueue, restart and retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-health-569s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs'), busRoot = join(dir, 'bus');
  const paths = claimNoticePaths(runsRoot);
  let now = Date.parse('2026-11-17T00:00:00Z');
  const team = 'T000FAKE';
  const mapped: SlackMapEntry = { topic: 'fake-topic-a', channel: 'C000AAAA' };
  const unmapped: SlackMapEntry = { topic: 'fake-topic-b', channel: 'C000BBBB' };
  const map: SlackMapEntry[] = [mapped]; // the only config mutation: repairing this map
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities: [],
    slack: { bridgeId: 'slack', teamId: team, map: [...map] } });
  const threadA = `${team}/${mapped.channel}/1700000000.000001`;
  const threadB = `${team}/${unmapped.channel}/1700000000.000002`;
  const passes: ClaimNoticePassResult[] = [];
  // A restart rebuilds the factory and the tick over the same files; nothing is carried in memory.
  const makeTick = () => createClaimNoticeTick({ now: () => now, intervalMs: 30_000, killed: () => false,
    pass: async () => {
      const result = await runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, now: () => now,
        readBoard: () => readFleetBoard({ path: ledger, now }) }));
      passes.push(result);
      return result;
    } });
  const write = { path: ledger, now: 0 };
  const seed = (): typeof write => ({ ...write, now: (now += 1_000) });

  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, seed()));
  const baselineTick = makeTick();
  expect(await baselineTick.maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
  expect(passes[0]).toMatchObject({ baselined: true, planned: 0 });
  const baseline = readFileSync(paths.prev);
  const a = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task A', agent: 'fake-owner-a' }, seed()));
  const b = must(claimFleetWork({ repo: 'fake/beta', task: 'fake task B', agent: 'fake-owner-b' }, seed()));
  const bindings = [{ claimId: a.claim.id, repo: 'fake/alpha', threadKey: threadA, pr: 7, head: 'abcdef1234567' },
    { claimId: b.claim.id, repo: 'fake/beta', threadKey: threadB, pr: 9, head: '1234567abcdef' }];
  for (const binding of bindings) expect(appendClaimThreadBinding(paths.bindings, binding, now).ok).toBe(true);
  let keys: string[] = []; // dedupe identities are taken from the real pass, not re-derived here

  const session = createSlackNoticeHealth();
  expect(createSlackNoticeHealth().health).toMatchObject({ status: 'unknown', recovery: 'unknown', lastAttemptAt: null });
  const firstTick = makeTick();
  now += 30_000;
  session.observe(await firstTick.maybeRun(), 'first');
  expect(passes[1]).toMatchObject({ planned: 2, sent: 1, failed: 1 });
  keys = passes[1]!.deliveries.map(d => d.dedupeKey);
  expect(keys.map((key, i) => key.includes(bindings[i]!.claimId) && key.includes(bindings[i]!.head))).toEqual([true, true]);
  expect(passes[1]!.deliveries).toMatchObject([
    { threadKey: threadA, result: 'sent' }, { threadKey: threadB, result: 'failed', reason: 'unmapped-channel' }]);
  expect(session.health).toMatchObject({ status: 'completed-with-failures', reason: 'notice-pass-failed',
    failedNotices: 1, recovery: 'blocked', lastAttemptAt: 'first' });
  expect(readFileSync(paths.prev)).toEqual(baseline); // partial failure retains the prior snapshot
  expect(readClaimNoticeSentRows(paths.sent)?.map(row => row.key)).toEqual([keys[0]]);
  const afterPartial = scanBusInbox({ root: busRoot, now: () => now });
  expect(afterPartial.rows.map(row => row.envelope.channel_ref)).toEqual([threadA]);

  now += 1_000;
  session.observe(await firstTick.maybeRun(), 'skip');
  expect(session.health).toMatchObject({ lastTick: 'interval', status: 'completed-with-failures',
    lastAttemptAt: 'first', recovery: 'blocked' });
  expect(passes).toHaveLength(2);

  map.push(unmapped);
  now += 30_000;
  const restarted = makeTick();
  session.observe(await restarted.maybeRun(), 'retry');
  expect(passes[2]).toMatchObject({ planned: 2, sent: 1, skipped: 1, failed: 0 });
  expect(passes[2]!.deliveries).toMatchObject([{ dedupeKey: keys[0], result: 'ledgered' },
    { dedupeKey: keys[1], result: 'sent' }]);
  expect(session.health).toMatchObject({ status: 'completed', reason: null, recovery: 'recovered', lastAttemptAt: 'retry' });
  expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ state: 'known', asOf: now, claims: [a.claim, b.claim] });
  now += 30_000;
  session.observe(await makeTick().maybeRun(), 'clean');
  expect(passes[3]).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(session.health).toMatchObject({ status: 'completed', recovery: 'recovered', failedNotices: 1 });
  // Health is per-session evidence; a new session knows nothing until it observes a tick.
  expect(createSlackNoticeHealth().health.recovery).toBe('unknown');

  // Independent fresh readers over the files: one envelope per notice, in the original threads.
  const fresh = scanBusInbox({ root: busRoot, now: () => now });
  expect(fresh).toMatchObject({ source: 'available', skipped: 0 });
  expect(fresh.rows.map(row => row.cursor)).toEqual([1, 2]);
  expect(fresh.rows.map(row => row.envelope)).toMatchObject([
    { to: mapped.topic, channel: 'slack', channel_ref: threadA, external: false,
      body: { kind: 'note', thread: `slack:${team}:${mapped.channel}:1700000000.000001`, inReplyTo: keys[0] } },
    { to: unmapped.topic, channel: 'slack', channel_ref: threadB, external: false,
      body: { kind: 'note', thread: `slack:${team}:${unmapped.channel}:1700000000.000002`, inReplyTo: keys[1] } }]);
  expect(readClaimNoticeSentRows(paths.sent)?.map(row => row.key)).toEqual(keys);
  // A bus-note receipt proves durable enqueue of that envelope id only; nothing here observes Slack delivery.
  const receipts = [passes[1]!.deliveries[0]!, passes[2]!.deliveries[1]!].map(d => d.receipt);
  expect(receipts).toEqual(fresh.rows.map(row => `bus-note:${row.envelope.id}`));
  expect(passes.flatMap(p => p.deliveries).every(d => d.receipt === undefined || d.receipt.startsWith('bus-note:'))).toBe(true);
});
