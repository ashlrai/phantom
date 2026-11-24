import { describe, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import type { ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';

const result: ClaimNoticePassResult = { status: 'completed', baselined: false,
  planned: 0, sent: 0, skipped: 0, failed: 0, deliveries: [] };
const interval = { ran: false, reason: 'interval' };

describe('claim tick clock recovery', () => {
  it('rebases a multi-hour rollback and does not spin on frozen or decreasing time', async () => {
    let clock = 36_000_000;
    let calls = 0;
    const tick = createClaimNoticeTick({ now: () => clock, killed: () => false,
      pass: async () => { calls++; return result; } });
    expect((await tick.maybeRun()).ran).toBe(true);
    clock = 1_000_000;
    expect(await tick.maybeRun()).toEqual(interval);
    expect(await tick.maybeRun()).toEqual(interval);
    clock -= 1;
    expect(await tick.maybeRun()).toEqual(interval);
    clock += 29_999;
    expect(await tick.maybeRun()).toEqual(interval);
    clock++;
    expect((await tick.maybeRun()).ran).toBe(true);
    expect(await tick.maybeRun()).toEqual(interval);
    expect(calls).toBe(2);
  });

  it('keeps one pass in flight across a rollback', async () => {
    let clock = 36_000_000;
    let resolve!: (value: ClaimNoticePassResult) => void;
    let calls = 0;
    const tick = createClaimNoticeTick({ now: () => clock, killed: () => false,
      pass: () => { calls++; return new Promise(yes => { resolve = yes; }); } });
    const first = tick.maybeRun();
    clock = 1_000_000;
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    resolve(result);
    await first;
    expect(await tick.maybeRun()).toEqual(interval);
    clock += 30_000;
    const second = tick.maybeRun();
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
    resolve(result);
    await second;
    expect(calls).toBe(2);
  });

  it.each(['killed', 'failed'] as const)('throttles a %s attempt after correction', async mode => {
    let clock = 36_000_000;
    let attempt = 0;
    const tick = createClaimNoticeTick({ now: () => clock,
      killed: () => mode === 'killed' && attempt++ === 0,
      pass: async () => { if (mode === 'failed' && attempt++ === 0) throw new Error('fake'); return result; } });
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: mode === 'killed' ? 'kill-switch' : 'pass-error' });
    clock = 1_000_000;
    expect(await tick.maybeRun()).toEqual(interval);
    clock += 29_999;
    expect(await tick.maybeRun()).toEqual(interval);
    clock++;
    expect((await tick.maybeRun()).ran).toBe(true);
  });
});
