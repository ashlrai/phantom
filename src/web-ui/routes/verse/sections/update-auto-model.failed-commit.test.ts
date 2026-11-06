import { expect, it } from 'vitest';
import { decideAutoUpdate, describeAutoDecision } from './update-auto-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';
import type { Workers } from '../fleet/workers-card-model.js';
const facts: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: null, headSha: 'aaaaaaa', headAt: null, originSha: 'bbbbbbb', branch: 'master', behind: 3, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 0, canFastForward: true };
const fleet: Workers = { v: 1, generatedAt: '', workers: [{ job: 'job123', repo: 'phantom', lane: 'work', tier: '1', ageSeconds: 900 }], publishesLastHour: [], sources: { workers: 'healthy' }, switches: [], paused: false, runsDir: '' };
const nowMs = 50_000_000;
const input = { policy: { enabled: true, quietMinutes: 10 }, status: facts, workers: fleet, nativePhase: undefined, lastAttempt: null, nowMs };
it('never retries an origin commit whose last attempt failed, with no time limit', () => {
  for (const at of [0, nowMs - 3 * 60 * 60_000, nowMs - 60_000]) {
    const lastAttempt = { originSha: 'bbbbbbb', at, outcome: 'failed' };
    expect(decideAutoUpdate({ ...input, lastAttempt })).toEqual({ apply: false, reason: 'failed-commit', lastAttempt });
  }
});
it('applies normally once origin/master moves past the failed sha', () => {
  expect(decideAutoUpdate({ ...input, status: { ...facts, originSha: 'ccccccc' },
    lastAttempt: { originSha: 'bbbbbbb', at: nowMs - 3 * 60 * 60_000, outcome: 'failed' } }))
    .toEqual({ apply: true, reason: 'ready' });
});
it('keeps refused on the 30-minute window and updated on recent-attempt', () => {
  expect(decideAutoUpdate({ ...input, lastAttempt: { originSha: 'bbbbbbb', at: nowMs - 31 * 60_000, outcome: 'refused' } }).apply).toBe(true);
  expect(decideAutoUpdate({ ...input, lastAttempt: { originSha: 'bbbbbbb', at: nowMs - 5 * 60_000, outcome: 'updated' } }))
    .toMatchObject({ apply: false, reason: 'recent-attempt' });
});
it('describes the pause with the 7-char sha and the newer-master wait', () => {
  const longSha = 'b'.repeat(40);
  const decision = decideAutoUpdate({ ...input, status: { ...facts, originSha: longSha },
    lastAttempt: { originSha: longSha, at: nowMs - 3 * 60 * 60_000, outcome: 'failed' } });
  const text = describeAutoDecision(decision, fleet, nowMs);
  expect(text).toBe('Auto-update paused: bbbbbbb failed to build. Waiting for a newer master.');
  expect(text).not.toContain(longSha);
});
