import { describe, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import type { ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';

const result: ClaimNoticePassResult = { status: 'completed', baselined: false,
  planned: 6, sent: 3, skipped: 2, failed: 1, deliveries: [] };
const counts = { ran: true, sent: 3, deduped: 2, failed: 1 };

function deferred() {
  let resolve!: (value: ClaimNoticePassResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ClaimNoticePassResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const work = deferred();
  let clock = 0;
  let calls = 0;
  const tick = createClaimNoticeTick({ now: () => clock, intervalMs: 30_000,
    killed: () => false, pass: () => ++calls === 1 ? work.promise : Promise.resolve(result) });
  return { tick, work, calls: () => calls, advance: () => { clock += 30_000; } };
}

describe('claim tick single flight', () => {
  it('blocks concurrent callers before and after interval expiry, then retries', async () => {
    const h = harness();
    const first = h.tick.maybeRun();
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    h.advance();
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    expect(h.calls()).toBe(1);
    h.work.resolve(result);
    expect(await first).toEqual(counts);
    expect(await h.tick.maybeRun()).toEqual(counts);
    expect(h.calls()).toBe(2);
  });

  it.each([false, true])('keeps aborted work fenced until settlement (reject=%s)', async reject => {
    const h = harness();
    const controller = new AbortController();
    const first = h.tick.maybeRun(controller.signal);
    controller.abort();
    expect(await first).toEqual({ ran: false, reason: 'aborted' });
    h.advance();
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    expect(h.calls()).toBe(1);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      if (reject) h.work.reject(new Error('fake failure'));
      else h.work.resolve(result);
      // Cross an event-loop turn to expose unhandled rejections; no timer or sleep.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(await h.tick.maybeRun()).toEqual(counts);
      expect(h.calls()).toBe(2);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('releases a rejected pass and preserves the attempt interval', async () => {
    const h = harness();
    const first = h.tick.maybeRun();
    h.work.reject(new Error('fake failure'));
    expect(await first).toEqual({ ran: false, reason: 'pass-error' });
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });
    h.advance();
    expect(await h.tick.maybeRun()).toEqual(counts);
  });

  it('releases the guard after a synchronous pass throw', async () => {
    let clock = 0;
    const tick = createClaimNoticeTick({ now: () => clock, killed: () => false,
      pass: () => { if (clock === 0) throw new Error('fake failure'); return Promise.resolve(result); } });
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'pass-error' });
    clock = 30_000;
    expect(await tick.maybeRun()).toEqual(counts);
  });

  it.each(['dry-run', 'board-unavailable', 'ledger-unavailable'] as const)(
    'preserves %s evidence and counts', async status => {
      const tick = createClaimNoticeTick({ killed: () => false,
        pass: async () => ({ ...result, status }) });
      const reason = status === 'board-unavailable' ? { reason: 'board-state-unknown' }
        : status === 'ledger-unavailable' ? { reason: 'sent-ledger-unreadable' } : {};
      expect(await tick.maybeRun()).toEqual({ ...counts, status, ...reason });
    });
});
