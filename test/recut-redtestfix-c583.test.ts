import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, readClaimNoticeSentRows, runClaimNoticePass,
  writeClaimNoticePrev } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(state: 'ASSIGNED' | 'BLOCKED' | 'VERIFIED' | 'RELEASED' = 'ASSIGNED') {
  const root = mkdtempSync(join(tmpdir(), 'redtestfix-c583-'));
  dirs.push(root);
  const runsRoot = join(root, 'runs'), busRoot = join(root, 'bus');
  const paths = claimNoticePaths(runsRoot);
  let now = Date.parse('2026-11-18T01:00:00Z');
  const claim = { id: 'claim-fake-c583', repo: 'fake/alpha', task: 'fake task', agent: 'fake-owner',
    claimedAt: now - 1_000, expiresAt: now + 3_600_000 };
  const binding = { claimId: claim.id, repo: claim.repo,
    threadKey: 'T000FAKE/C000FAKE/1700000000.000001', pr: 7, head: 'abcdef1234567' };
  const previous = { state: 'known' as const, claims: state === 'ASSIGNED' ? [] : [claim],
    messages: [], asOf: now - (state === 'ASSIGNED' ? 2_000 : 750) };
  const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known',
    claims: state === 'ASSIGNED' ? [claim] : [], proposals: [], expiredClaims: 0,
    messages: state === 'BLOCKED' || state === 'VERIFIED' ? [{
      id: `return-${claim.id}`, from: claim.agent, to: 'all', at: now - 500, expiresAt: now + 3_600_000,
      body: `RESULT ${state} ${claim.repo} claim ${claim.id} task "fake task": `
        + (state === 'BLOCKED' ? 'dependency fake-upstream' : 'pr #7 head abcdef1234567'),
    }] : [] };
  writeClaimNoticePrev(paths.prev, previous);
  const bind = (threadKey = binding.threadKey) => {
    expect(appendClaimThreadBinding(paths.bindings, { ...binding, threadKey }, now).ok).toBe(true);
  };
  bind();
  const pass = (failLedger = false, dryRun = false) => runClaimNoticePass(claimNoticePassDeps({
    runsRoot, busRoot, now: () => now, readBoard: () => board,
    readConfig: () => ({ path: 'fake-config', state: 'ok', teamIdentities: [],
      slack: { bridgeId: 'slack', teamId: 'T000FAKE', map: [{ topic: 'fake-topic', channel: 'C000FAKE' }] } }),
    ...(failLedger ? { appendSentLedger: () => { throw new Error('fake checkpoint failure'); } } : {}),
  }, dryRun));
  return { paths, busRoot, bind, pass, advance: () => { now += 30_000; }, now: () => now };
}

it.each(['ASSIGNED', 'BLOCKED', 'VERIFIED', 'RELEASED'] as const)(
  'keeps the first %s timestamp across file-backed restarts, then retires it after checkpoint', async state => {
    const f = fixture(state);
    const before = readFileSync(f.paths.prev);
    const first = await f.pass(true);
    expect(first).toMatchObject({ planned: 1, failed: 1, sent: 0,
      deliveries: [{ state, result: 'failed', reason: 'ledger-append-failed' }] });
    const notice = first.deliveries[0]!;
    expect(readClaimNoticeSentRows(f.paths.clocks)).toEqual([{ key: notice.dedupeKey, at: f.now() }]);
    expect(readFileSync(f.paths.clocks, 'utf8')).not.toContain(notice.text);
    expect(readFileSync(f.paths.prev)).toEqual(before);
    const inbox = scanBusInbox({ root: f.busRoot });
    f.advance();
    const retry = await f.pass(); // reconstruct dependencies; no in-memory cache
    expect(retry).toMatchObject({ planned: 1, failed: 0, sent: 1,
      deliveries: [{ text: notice.text, dedupeKey: notice.dedupeKey, result: 'sent' }] });
    expect(scanBusInbox({ root: f.busRoot })).toEqual(inbox);
    expect(readClaimNoticeSentRows(f.paths.sent)).toEqual([{ key: notice.dedupeKey, at: f.now() }]);
    expect(readClaimNoticeSentRows(f.paths.clocks)).toEqual([]);
    expect(JSON.parse(readFileSync(f.paths.prev, 'utf8')).asOf).toBe(f.now());
  });

it('preserves the bus conflict guard when a retry changes the bound destination', async () => {
  const f = fixture();
  const first = await f.pass(true);
  const original = first.deliveries[0]!;
  const inbox = scanBusInbox({ root: f.busRoot });
  const before = readFileSync(f.paths.prev);
  f.advance();
  f.bind('T000FAKE/C000FAKE/1700000000.000002');
  expect(await f.pass()).toMatchObject({ sent: 0, failed: 1,
    deliveries: [{ result: 'failed', reason: 'bus-conflict', text: original.text }] });
  expect(scanBusInbox({ root: f.busRoot })).toEqual(inbox);
  expect(readClaimNoticeSentRows(f.paths.sent)).toEqual([]);
  expect(readFileSync(f.paths.prev)).toEqual(before);
  f.bind();
  expect(await f.pass()).toMatchObject({ sent: 1, failed: 0 });
});

it('leaves attempt clocks and the bus untouched during a dry run', async () => {
  const f = fixture();
  const before = readFileSync(f.paths.prev);
  expect(await f.pass(false, true)).toMatchObject({ status: 'dry-run', planned: 1, sent: 0 });
  expect(existsSync(f.paths.clocks)).toBe(false);
  expect(existsSync(f.paths.sent)).toBe(false);
  expect(scanBusInbox({ root: f.busRoot }).rows).toEqual([]);
  expect(readFileSync(f.paths.prev)).toEqual(before);
});

it.each(['corrupt', 'future', 'capacity'] as const)('refuses %s attempt clocks before any send', async mode => {
  const f = fixture();
  const before = readFileSync(f.paths.prev);
  const planned = await f.pass(false, true);
  const key = planned.deliveries[0]!.dedupeKey;
  const text = mode === 'corrupt' ? '{torn\n' : mode === 'future'
    ? JSON.stringify({ v: 1, key, at: f.now() + 1 }) + '\n'
    : Array.from({ length: 5000 }, (_, i) => JSON.stringify({ v: 1, key: `fake-${i}`, at: 1 })).join('\n') + '\n';
  writeFileSync(f.paths.clocks, text, { mode: 0o600 });
  expect(await f.pass()).toMatchObject({ status: 'ledger-unavailable', reason: 'notice-clock-unavailable', sent: 0 });
  expect(scanBusInbox({ root: f.busRoot }).rows).toEqual([]);
  expect(existsSync(f.paths.sent)).toBe(false);
  expect(readFileSync(f.paths.prev)).toEqual(before);
  expect(readFileSync(f.paths.clocks, 'utf8')).toBe(text);
});
