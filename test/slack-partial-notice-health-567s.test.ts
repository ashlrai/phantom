import { expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { createSlackNoticeHealth } from '../src/cli/slack-notice-health.js';
import type { ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';

const pass = (sent: number, failed: number): ClaimNoticePassResult => ({
  status: 'completed', baselined: false, planned: sent + failed, sent, failed, skipped: 0, deliveries: [],
  reason: 'untrusted synthetic detail',
});

it.each([[0, 2], [1, 1]])('keeps %i sent and %i failed blocked through skips and failed retry', async (sent, failed) => {
  let now = 0;
  let result = pass(sent, failed);
  let resolvePass: ((value: ClaimNoticePassResult) => void) | undefined;
  const tick = createClaimNoticeTick({ now: () => now, intervalMs: 10, killed: () => false,
    pass: () => resolvePass ? new Promise(resolve => { resolvePass = resolve; }) : Promise.resolve(result) });
  const h = createSlackNoticeHealth();
  h.observe(await tick.maybeRun(), 'first');
  expect(h.health).toMatchObject({ status: 'completed-with-failures', reason: 'notice-pass-failed', failedNotices: failed, recovery: 'blocked' });
  h.observe(await tick.maybeRun(), 'skip');
  expect(h.health).toMatchObject({ lastTick: 'interval', lastAttemptAt: 'first', recovery: 'blocked' });
  now = 10;
  resolvePass = () => {};
  const pending = tick.maybeRun();
  await Promise.resolve();
  h.observe(await tick.maybeRun(), 'in-flight');
  expect(h.health).toMatchObject({ lastTick: 'in-flight', status: 'completed-with-failures', recovery: 'blocked' });
  resolvePass!(result);
  h.observe(await pending, 'retry');
  expect(h.health).toMatchObject({ failedNotices: failed * 2, recovery: 'blocked' });
  now = 20;
  resolvePass = undefined;
  result = pass(1, 0);
  h.observe(await tick.maybeRun(), 'success');
  expect(h.health).toMatchObject({ status: 'completed', reason: null, recovery: 'recovered' });
});

it('does not mistake an outage, dry run, abort, or kill for recovery', () => {
  const h = createSlackNoticeHealth();
  h.observe({ ran: true, sent: 0, deduped: 0, failed: 0, status: 'board-unavailable', reason: 'private' }, 'outage');
  h.observe({ ran: true, sent: 1, deduped: 0, failed: 1 }, 'partial');
  expect(h.health).toMatchObject({ blocked: 1, failedNotices: 1, status: 'completed-with-failures', recovery: 'blocked' });
  for (const reason of ['aborted', 'kill-switch'] as const) {
    h.observe({ ran: false, reason }, reason);
    expect(h.health).toMatchObject({ status: reason, recovery: 'unknown' });
  }
  h.observe({ ran: true, sent: 0, deduped: 0, failed: 1, status: 'dry-run' }, 'dry');
  expect(h.health).toMatchObject({ status: 'dry-run', recovery: 'unknown', failedNotices: 1 });
  h.observe({ ran: true, sent: 0, deduped: 0, failed: 0 }, 'clean');
  expect(h.health.recovery).toBe('recovered');
});
