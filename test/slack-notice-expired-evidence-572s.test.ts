import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { inspectBusInbox, listBusInboxAfter, scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('does not mistake an expired assignment enqueue for Slack delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-expired-572s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs'), busRoot = join(dir, 'bus');
  const receiptRoot = join(dir, 'receipts'), paths = claimNoticePaths(runsRoot);
  mkdirSync(receiptRoot, { mode: 0o700 });
  writeFileSync(join(receiptRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {} }), { mode: 0o600 });
  let now = Date.parse('2026-11-17T00:00:00Z');
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const thread = 'T000FAKE/C000FAKE/1700000000.000001';
  const readConfig = (): AgentNetworkConfig => ({ path: 'fake', state: 'ok', teamIdentities: [],
    slack: { bridgeId: 'slack', teamId: 'T000FAKE', map: [{ topic: 'fake-topic', channel: 'C000FAKE' }] } });
  const readBoard = () => readFleetBoard({ path: ledger, now });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, readBoard, now: () => now }));
  must(postFleetMessage({ from: 'fake-host', to: 'all', body: 'seed', ttlMs: 1 }, { path: ledger, now }));
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  const baseline = readFileSync(paths.prev, 'utf8');
  now += 1_000;
  vi.setSystemTime(now);
  const { claim } = must(claimFleetWork({ repo: 'fake/repo', task: 'fake assignment', agent: 'fake-owner' }, { path: ledger, now }));
  expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo, threadKey: thread,
    pr: 7, head: 'abcdef1234567' }, now).ok).toBe(true);
  const first = await pass();
  expect(first).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0,
    deliveries: [{ state: 'ASSIGNED', threadKey: thread, result: 'sent' }] });
  const delivery = first.deliveries[0]!;
  const live = scanBusInbox({ root: busRoot, now: () => now });
  expect(live).toMatchObject({ source: 'available', skipped: 0 });
  expect(live.rows).toHaveLength(1);
  const row = live.rows[0]!;
  expect(row.envelope).toMatchObject({ channel: 'slack', channel_ref: thread, to: 'fake-topic',
    body: { kind: 'note', inReplyTo: delivery.dedupeKey, thread: 'slack:T000FAKE:C000FAKE:1700000000.000001' } });
  expect(delivery.receipt).toBe(`bus-note:${row.envelope.id}`);
  expect(readClaimNoticeSentRows(paths.sent)).toMatchObject([{ key: delivery.dedupeKey, at: now }]);
  const sent = readFileSync(paths.sent, 'utf8');
  const snapshot = readFileSync(paths.prev, 'utf8');
  expect(snapshot).not.toBe(baseline);
  expect(JSON.parse(snapshot)).toMatchObject({ state: 'known', asOf: now, claims: [claim] });

  now = row.receivedAt + row.envelope.ttl + 1;
  vi.setSystemTime(now);
  expect(listBusInboxAfter(0, 50, { root: busRoot, now: () => now })).toEqual({ status: 'ok', messages: [], nextCursor: row.cursor });
  expect(inspectBusInbox({ root: busRoot, now: () => now })).toMatchObject({ source: 'available', retainedCount: 1, liveCount: 0, expiredCount: 1 });
  expect(readSlackSendReceipts({ stateRoot: receiptRoot })).toEqual({ state: 'ok', receipts: [] });
  const view = (stateRoot: string) => readClaimNoticeView({ runsRoot, readBoard, readConfig, now: () => now,
    readSendReceipts: () => readSlackSendReceipts({ stateRoot }) });
  // A durable bus enqueue is not a Slack transport receipt, even after its TTL has passed.
  expect(await view(receiptRoot)).toMatchObject({ source: 'ok', sent: { total: 1,
    recent: [{ state: 'ASSIGNED', claimId: claim.id, delivery: 'no-slack-receipt' }] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 1, unknown: 0 } });
  expect(await view(join(dir, 'missing-receipts'))).toMatchObject({ sent: { recent: [{ delivery: 'unknown' }] },
    delivery: { sendStore: 'missing', slackSent: 0, unknown: 1 } });
  expect(readFileSync(paths.sent, 'utf8')).toBe(sent);
  expect(readFileSync(paths.prev, 'utf8')).toBe(snapshot);
  expect(scanBusInbox({ root: busRoot, now: () => row.receivedAt }).rows).toEqual([row]);

  const next = await pass();
  expect(next.deliveries.filter(d => d.state === 'ASSIGNED')).toEqual([]);
  expect(readClaimNoticeSentRows(paths.sent)?.filter(r => r.key === delivery.dedupeKey)).toHaveLength(1);
  const retained = inspectBusInbox({ root: busRoot, now: () => now });
  // The claim itself also expired; a release notice may be enqueued independently.
  expect(next.failed).toBe(0);
  expect(retained.source).toBe('available');
  expect((await view(receiptRoot)).sent.recent.find(r => r.state === 'ASSIGNED')?.delivery).toBe('no-slack-receipt');
});
