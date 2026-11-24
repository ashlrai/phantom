import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const must = <T>(result: FleetCoordinationResult<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

type Outcome = Awaited<ReturnType<ClaimNoticeSendDeps['send']>>;

it('replays a rejected delivery after its tick waiter has stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-rejection-564s-'));
  chmodSync(dir, 0o700);
  const ledger = join(dir, 'coordination.jsonl');
  const runs = join(dir, 'runs');
  const paths = claimNoticePaths(runs);
  let now = Date.parse('2026-11-16T00:00:00Z');
  let tickTime = 1_000;
  const attempts: { thread: string; key: string }[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  let rejectSend!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const pending = new Promise<Outcome>((_resolve, reject) => { rejectSend = reject; });
  let repaired = false;
  const threads = ['T000FAKE/C000FAKE/1700000000.000001', 'T000FAKE/C000FAKE/1700000000.000002'];
  const send: ClaimNoticeSendDeps['send'] = (thread, _text, key) => {
    attempts.push({ thread, key });
    if (thread === threads[1] && !repaired) { markStarted(); return pending; }
    return { ok: true, receipt: 'synthetic-receipt' };
  };
  const pass = () => runClaimNoticePass({ ...claimNoticeFileDeps(runs),
    readBoard: () => readFleetBoard({ path: ledger, now, reap: false }), send, now: () => now });
  let underlying: ReturnType<typeof pass> = Promise.resolve({ status: 'completed', baselined: false,
    planned: 0, sent: 0, failed: 0, skipped: 0, deliveries: [] });
  const tick = () => createClaimNoticeTick({ intervalMs: 30_000, now: () => tickTime,
    killed: () => false, pass: () => (underlying = pass()) });
  const controller = new AbortController();
  try {
    must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, { path: ledger, now }));
    expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
    const baseline = readFileSync(paths.prev);
    const claims = ['alpha', 'beta'].map((name, index) => {
      now += 5_000;
      const claim = must(claimFleetWork({ repo: `fake/${name}`, task: `task ${name}`,
        agent: `fake-owner-${name}` }, { path: ledger, now })).claim;
      const binding = { claimId: claim.id, repo: claim.repo, threadKey: threads[index]!,
        pr: index + 7, head: index === 0 ? 'abcdef1234567' : '1234567abcdef' };
      expect(appendClaimThreadBinding(paths.bindings, binding, now).ok).toBe(true);
      return { claim, binding, key: JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]) };
    });
    const ownership = [readFileSync(ledger), readFileSync(paths.bindings)];
    const firstTick = tick();
    const waiter = firstTick.maybeRun(controller.signal);
    await started;
    controller.abort();
    expect(await waiter).toEqual({ ran: false, reason: 'aborted' });
    tickTime += 31_000;
    expect(await firstTick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    expect(attempts).toEqual(claims.map(({ binding, key }) => ({ thread: binding.threadKey, key })));
    rejectSend(new Error('synthetic transport rejection 564s'));
    const result = await underlying;
    expect(result).toMatchObject({ planned: 2, sent: 1, failed: 1,
      deliveries: [{ result: 'sent' }, { result: 'failed', reason: 'send-threw', dedupeKey: claims[1]!.key }] });
    expect(JSON.stringify(result)).not.toContain('synthetic transport rejection 564s');
    const rows = () => readFileSync(paths.sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows()).toEqual([{ v: 1, at: now, key: claims[0]!.key }]);
    expect(readFileSync(paths.prev)).toEqual(baseline);
    // Yield an event-loop turn so Node and the runner can report unhandled rejections.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);

    repaired = true;
    expect(await tick().maybeRun()).toEqual({ ran: true, sent: 1, deduped: 1, failed: 0 });
    expect(attempts).toEqual([
      ...claims.map(({ binding, key }) => ({ thread: binding.threadKey, key })),
      { thread: claims[1]!.binding.threadKey, key: claims[1]!.key },
    ]);
    expect(rows()).toEqual(claims.map(({ key }) => ({ v: 1, at: now, key })));
    expect(JSON.parse(readFileSync(paths.prev, 'utf8'))).toMatchObject({ state: 'known', claims: claims.map(c => c.claim) });
    const settled = [readFileSync(paths.prev), readFileSync(paths.sent)];
    expect(await tick().maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
    expect(attempts).toHaveLength(3);
    expect([readFileSync(paths.prev), readFileSync(paths.sent)]).toEqual(settled);
    expect([readFileSync(ledger), readFileSync(paths.bindings)]).toEqual(ownership);
    expect(unhandled).toEqual([]);
  } finally {
    rejectSend(new Error('synthetic cleanup rejection'));
    controller.abort();
    await underlying;
    await new Promise<void>(resolve => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    rmSync(dir, { recursive: true, force: true });
  }
});
