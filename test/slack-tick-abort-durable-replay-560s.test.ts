import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const must = <T>(r: FleetCoordinationResult<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
type Outcome = Awaited<ReturnType<ClaimNoticeSendDeps['send']>>;

it('keeps a pending assignment through an aborted tick and replays only it after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-abort-560s-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl');
  const paths = claimNoticePaths(join(dir, 'runs'));
  let now = Date.parse('2026-11-16T00:00:00Z');
  const threadA = 'T000FAKE/C000FAKE/1700000000.000001';
  const threadB = 'T000FAKE/C000FAKE/1700000000.000002';
  const attempts: { thread: string; key: string; text: string }[] = [];
  let stall: ((o: Outcome) => void) | undefined;
  let reached!: () => void;
  const stalled = new Promise<void>(r => { reached = r; });
  let hold = true;
  const send: ClaimNoticeSendDeps['send'] = (thread, text, key) => {
    attempts.push({ thread, key, text });
    if (thread === threadB && hold) {
      reached();
      return new Promise<Outcome>(r => { stall = r; });
    }
    return { ok: true, receipt: 'synthetic-durable-receipt' };
  };
  const options = () => ({ path: ledger, now: now += 5_000 });
  // Each call rebuilds every file dependency from the directory (a process restart).
  const pass = () => runClaimNoticePass({ ...claimNoticeFileDeps(join(dir, 'runs')),
    readBoard: () => readFleetBoard({ path: ledger, now }), send, now: () => now });
  const tickNow = { t: 1_000 };
  const makeTick = () => createClaimNoticeTick({ intervalMs: 30_000, now: () => tickNow.t, killed: () => false, pass });

  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, options()));
  expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
  const baseline = readFileSync(paths.prev);
  const a = must(claimFleetWork({ repo: 'fake/alpha', task: 'task A', agent: 'fake-owner-a' }, options()));
  const b = must(claimFleetWork({ repo: 'fake/beta', task: 'task B', agent: 'fake-owner-b' }, options()));
  const bindA = { claimId: a.claim.id, repo: 'fake/alpha', threadKey: threadA, pr: 7, head: 'abcdef1234567' };
  const bindB = { claimId: b.claim.id, repo: 'fake/beta', threadKey: threadB, pr: 9, head: '1234567abcdef' };
  expect(appendClaimThreadBinding(paths.bindings, bindA, now).ok).toBe(true);
  expect(appendClaimThreadBinding(paths.bindings, bindB, now).ok).toBe(true);
  const keyA = JSON.stringify(['ASSIGNED', a.claim.repo, a.claim.id, a.claim.agent, a.claim.claimedAt, bindA.head]);
  const keyB = JSON.stringify(['ASSIGNED', b.claim.repo, b.claim.id, b.claim.agent, b.claim.claimedAt, bindB.head]);

  let underlying: Promise<unknown> = Promise.resolve();
  const tick = createClaimNoticeTick({ intervalMs: 30_000, now: () => tickNow.t, killed: () => false,
    pass: () => (underlying = pass()) });
  const controller = new AbortController();
  try {
    const first = tick.maybeRun(controller.signal);
    await stalled;
    controller.abort();
    // Aborted means the waiter stopped, not that delivery completed.
    expect(await first).toEqual({ ran: false, reason: 'aborted' });
    tickNow.t += 31_000; // interval expired, yet the original pass still owns the guard
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    expect(attempts.map(x => x.key)).toEqual([keyA, keyB]);
    const sentRows = () => readFileSync(paths.sent, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(sentRows()).toEqual([{ v: 1, at: now, key: keyA }]);
    expect(readFileSync(paths.prev)).toEqual(baseline);
  } finally {
    hold = false;
    stall?.({ ok: false, reason: 'synthetic-failure' });
    controller.abort();
  }
  expect(await underlying).toMatchObject({ planned: 2, sent: 1, failed: 1 });
  expect(readFileSync(paths.prev)).toEqual(baseline);
  const deliveredAt = JSON.parse(readFileSync(paths.sent, 'utf8').trim()).at as number;

  // Restart: new tick + new file dependencies over the same directory.
  tickNow.t += 31_000;
  const restarted = await makeTick().maybeRun();
  expect(restarted).toEqual({ ran: true, sent: 1, deduped: 1, failed: 0 });
  expect(attempts).toHaveLength(3);
  expect(attempts[2]).toMatchObject({ thread: threadB, key: keyB });
  expect(attempts[2].text).toContain('fake-owner-b');
  const rows = readFileSync(paths.sent, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(rows).toEqual([{ v: 1, at: deliveredAt, key: keyA }, { v: 1, at: now, key: keyB }]);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ state: 'known', claims: [a.claim, b.claim] });
  const settled = [readFileSync(paths.prev), readFileSync(paths.sent)];

  tickNow.t += 31_000;
  expect(await makeTick().maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
  expect(attempts).toHaveLength(3);
  expect([readFileSync(paths.prev), readFileSync(paths.sent)]).toEqual(settled);
});
