import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const must = <T>(r: FleetCoordinationResult<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
type Outcome = Awaited<ReturnType<ClaimNoticeSendDeps['send']>>;

it('persists a delivery that succeeds after its tick waiter aborts, without replay on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-abort-561s-'));
  chmodSync(dir, 0o700);
  const ledger = join(dir, 'coordination.jsonl');
  const paths = claimNoticePaths(join(dir, 'runs'));
  let now = Date.parse('2026-11-16T00:00:00Z');
  let tickTime = 1_000;
  const thread = 'T000FAKE/C000FAKE/1700000000.000001';
  const attempts: { thread: string; key: string; text: string }[] = [];
  let resolveSend!: (result: Outcome) => void;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const pending = new Promise<Outcome>(resolve => { resolveSend = resolve; });
  const send: ClaimNoticeSendDeps['send'] = (destination, text, key) => {
    attempts.push({ thread: destination, key, text });
    reached();
    return pending;
  };
  const options = () => ({ path: ledger, now: now += 5_000 });
  const pass = () => runClaimNoticePass({ ...claimNoticeFileDeps(join(dir, 'runs')),
    readBoard: () => readFleetBoard({ path: ledger, now }), send, now: () => now });
  let underlying: Promise<unknown> = Promise.resolve();
  const makeTick = () => createClaimNoticeTick({ intervalMs: 30_000, now: () => tickTime,
    killed: () => false, pass: () => (underlying = pass()) });
  const controller = new AbortController();
  try {
    must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, options()));
    expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
    const baseline = readFileSync(paths.prev);
    const claim = must(claimFleetWork({ repo: 'fake/alpha', task: 'task A', agent: 'fake-owner' }, options())).claim;
    const binding = { claimId: claim.id, repo: claim.repo, threadKey: thread, pr: 7, head: 'abcdef1234567' };
    expect(appendClaimThreadBinding(paths.bindings, binding, now).ok).toBe(true);
    const key = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]);
    const before = [readFileSync(ledger), readFileSync(paths.bindings)];
    const tick = makeTick();
    const waiter = tick.maybeRun(controller.signal);
    await started;
    controller.abort();
    expect(await waiter).toEqual({ ran: false, reason: 'aborted' });
    expect(existsSync(paths.sent) ? readFileSync(paths.sent, 'utf8').trim() : '').toBe('');
    expect(readFileSync(paths.prev)).toEqual(baseline);
    tickTime += 31_000;
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    expect(attempts).toHaveLength(1);
    resolveSend({ ok: true, receipt: 'synthetic-late-success-receipt' });
    expect(await underlying).toMatchObject({ planned: 1, sent: 1, failed: 0 });
    expect(JSON.parse(readFileSync(paths.sent, 'utf8').trim())).toEqual({ v: 1, at: now, key });
    expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ state: 'known', claims: [claim] });
    expect(readFileSync(paths.prev)).not.toEqual(baseline);
    const settled = [readFileSync(paths.prev), readFileSync(paths.sent)];
    tickTime += 31_000;
    expect(await makeTick().maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ thread, key });
    expect(attempts[0]!.text).toContain('fake-owner');
    expect([readFileSync(paths.prev), readFileSync(paths.sent)]).toEqual(settled);
    expect([readFileSync(ledger), readFileSync(paths.bindings)]).toEqual(before);
  } finally {
    resolveSend({ ok: true, receipt: 'synthetic-cleanup-receipt' });
    controller.abort();
    await underlying;
    rmSync(dir, { recursive: true, force: true });
  }
});
