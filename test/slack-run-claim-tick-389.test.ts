/**
 * RQ-PHX-SLACKRUNCLAIMTICK389 — the claim-notice tick that `phm channels slack
 * run` calls once per loop iteration. Injected clock, pass and kill switch:
 * no real board, ledger, bus, credentials or network.
 */
import { describe, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import type { ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';

const result = (over: Partial<ClaimNoticePassResult> = {}): ClaimNoticePassResult => ({
  status: 'completed', baselined: false, planned: 0, sent: 0, failed: 0, skipped: 0, deliveries: [], ...over,
});

function harness(pass: () => Promise<ClaimNoticePassResult>, killed = () => false) {
  let clock = 1_000_000;
  let calls = 0;
  const tick = createClaimNoticeTick({
    intervalMs: 30_000, now: () => clock, killed,
    pass: () => { calls++; return pass(); },
  });
  return { tick, advance: (ms: number) => { clock += ms; }, calls: () => calls };
}

describe('createClaimNoticeTick', () => {
  it('runs immediately, then at most once per interval', async () => {
    const h = harness(async () => result());
    expect((await h.tick.maybeRun()).ran).toBe(true);
    h.advance(29_999);
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });
    expect(h.calls()).toBe(1);
    h.advance(1);
    expect((await h.tick.maybeRun()).ran).toBe(true);
    expect(h.calls()).toBe(2);
  });

  it('skips the pass while the kill switch is armed', async () => {
    let armed = true;
    const h = harness(async () => result(), () => armed);
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'kill-switch' });
    expect(h.calls()).toBe(0);
    armed = false;
    h.advance(30_000);
    expect((await h.tick.maybeRun()).ran).toBe(true);
  });

  it('never throws: a failing pass reports pass-error and retries next interval', async () => {
    let fail = true;
    const h = harness(async () => { if (fail) throw new Error('boom'); return result({ sent: 1 }); });
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'pass-error' });
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });
    fail = false;
    h.advance(30_000);
    expect(await h.tick.maybeRun()).toEqual({ ran: true, sent: 1, deduped: 0, failed: 0 });
    expect(h.calls()).toBe(2);
  });

  it('a synchronous throw from the kill check or pass is also a pass-error', async () => {
    const h = harness(async () => result(), () => { throw new Error('kill read failed'); });
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'pass-error' });
  });

  it('reports counts from the pass result (deduped = ledger-fenced skipped)', async () => {
    const h = harness(async () => result({ planned: 6, sent: 3, skipped: 2, failed: 1 }));
    expect(await h.tick.maybeRun()).toEqual({ ran: true, sent: 3, deduped: 2, failed: 1 });
  });

  it('an abort resolves without waiting on an in-flight pass', async () => {
    const h = harness(() => new Promise<ClaimNoticePassResult>(() => { /* never settles */ }));
    const controller = new AbortController();
    const pending = h.tick.maybeRun(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ran: false, reason: 'aborted' });
    expect(await h.tick.maybeRun(controller.signal)).toEqual({ ran: false, reason: 'aborted' });
  });
});
