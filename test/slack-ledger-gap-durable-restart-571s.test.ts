import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { createSlackNoticeHealth } from '../src/cli/slack-notice-health.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass,
  type ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('recovers the sent-ledger gap through real bus dedupe without a second assignment envelope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-ledger-gap-571s-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs'), busRoot = join(dir, 'bus');
  const paths = claimNoticePaths(runsRoot);
  let now = Date.parse('2026-11-18T00:00:00Z');
  // The actual sender's bus append uses Date.now; control its clock, not its implementation.
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const team = 'T000FAKE', channel = 'C000FAKE', topic = 'fake-topic';
  const thread = `${team}/${channel}/1700000000.000001`;
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities: [],
    slack: { bridgeId: 'slack', teamId: team, map: [{ topic, channel }] } });
  const passes: ClaimNoticePassResult[] = [];
  const makeTick = (failLedger = false) => {
    // Every restart constructs new file dependencies, actual sender, and tick state.
    const deps = claimNoticePassDeps({ runsRoot, busRoot, readConfig, now: () => now,
      readBoard: () => readFleetBoard({ path: ledger, now }),
      ...(failLedger ? { appendSentLedger: () => { throw new Error('fake ledger checkpoint failure'); } } : {}) });
    return createClaimNoticeTick({ now: () => now, killed: () => false, pass: async () => {
      const result = await runClaimNoticePass(deps);
      passes.push(result);
      return result;
    } });
  };
  const seed = () => ({ path: ledger, now: (now += 1_000) });
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, seed()));
  expect(await makeTick().maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
  expect(passes[0]).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  const baseline = readFileSync(paths.prev);
  expect(scanBusInbox({ root: busRoot, now: () => now }).rows).toEqual([]);
  const { claim } = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task', agent: 'fake-owner' }, seed()));
  const binding = { claimId: claim.id, repo: claim.repo, threadKey: thread, pr: 7, head: 'abcdef1234567' };
  expect(appendClaimThreadBinding(paths.bindings, binding, now).ok).toBe(true);
  const health = createSlackNoticeHealth();

  now += 30_000;
  const first = await makeTick(true).maybeRun();
  health.observe(first, 'gap');
  expect(first).toEqual({ ran: true, sent: 0, deduped: 0, failed: 1 });
  expect(passes[1]).toMatchObject({ status: 'completed', baselined: false, planned: 1,
    sent: 0, skipped: 0, failed: 1,
    deliveries: [{ threadKey: thread, state: 'ASSIGNED', result: 'failed', reason: 'ledger-append-failed' }] });
  const delivery = passes[1]!.deliveries[0]!;
  const key = delivery.dedupeKey; // capture the real planner identity, never reimplement it
  expect(key).toContain(claim.id);
  expect(key).toContain(binding.head);
  expect(delivery.receipt).toBeUndefined(); // enqueue alone does not make this pass successful
  expect(readClaimNoticeSentRows(paths.sent)).toEqual([]);
  expect(readFileSync(paths.prev)).toEqual(baseline);
  expect(health.health).toMatchObject({ status: 'completed-with-failures', recovery: 'blocked',
    reason: 'notice-pass-failed', failedNotices: 1, lastAttemptAt: 'gap' });
  const enqueued = scanBusInbox({ root: busRoot, now: () => now });
  expect(enqueued).toMatchObject({ source: 'available', skipped: 0 });
  expect(enqueued.rows).toHaveLength(1);
  expect(enqueued.rows[0]).toMatchObject({ cursor: 1, receivedAt: now,
    envelope: { channel: 'slack', channel_ref: thread, to: topic, external: false,
      body: { kind: 'note', thread: `slack:${team}:${channel}:1700000000.000001`, inReplyTo: key } } });
  const original = enqueued.rows[0]!;
  // Exact durable bytes and receivedAt also distinguish duplicate detection from a rewrite.
  const inboxPath = join(busRoot, 'bus-inbox', 'messages.json');
  const inboxBeforeRetry = readFileSync(inboxPath);

  now += 30_000;
  const retry = await makeTick().maybeRun();
  health.observe(retry, 'retry');
  expect(passes[2]!.deliveries[0]!.dedupeKey).toBe(key);
  // Regression: a later "as of" in the payload currently causes bus-conflict
  // under the same envelope id. Keep the required recovery assertion red.
  expect(passes[2]!.deliveries[0]!.reason).toBeUndefined();
  // Bus duplicates are successful sender outcomes, not sent-ledger skips.
  expect(retry).toEqual({ ran: true, sent: 1, deduped: 0, failed: 0 });
  expect(passes[2]).toMatchObject({ status: 'completed', baselined: false, planned: 1,
    sent: 1, skipped: 0, failed: 0, deliveries: [{ threadKey: thread, state: 'ASSIGNED',
      dedupeKey: key, text: delivery.text, result: 'sent', receipt: `bus-note:${original.envelope.id}` }] });
  expect(readClaimNoticeSentRows(paths.sent)).toEqual([{ key, at: now }]);
  expect(readFileSync(paths.prev)).not.toEqual(baseline);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ state: 'known', asOf: now, claims: [claim] });
  expect(health.health).toMatchObject({ status: 'completed', reason: null, recovery: 'recovered', lastAttemptAt: 'retry' });
  const restartedScan = scanBusInbox({ root: busRoot, now: () => now });
  expect(restartedScan).toEqual(enqueued); // exactly one original envelope/id/cursor/thread/identity
  expect(readFileSync(inboxPath)).toEqual(inboxBeforeRetry);
  const sentAfterRetry = readFileSync(paths.sent);

  now += 30_000;
  health.observe(await makeTick().maybeRun(), 'clean');
  expect(passes[3]).toMatchObject({ status: 'completed', planned: 0, sent: 0, skipped: 0, failed: 0, deliveries: [] });
  expect(health.health).toMatchObject({ status: 'completed', recovery: 'recovered' });
  expect(readClaimNoticeSentRows(paths.sent)).toEqual([{ key, at: now - 30_000 }]);
  expect(readFileSync(paths.sent)).toEqual(sentAfterRetry);
  expect(scanBusInbox({ root: busRoot, now: () => now })).toEqual(enqueued);
  expect(readFileSync(inboxPath)).toEqual(inboxBeforeRetry);
  expect(createSlackNoticeHealth().health.recovery).toBe('unknown'); // health itself is session-local
  // bus-note receipts prove durable enqueue only. No drain/Slack transport is invoked or observed.
});
