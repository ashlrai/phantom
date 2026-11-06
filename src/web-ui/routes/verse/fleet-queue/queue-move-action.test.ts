import { expect, it, vi, afterEach } from 'vitest';
import { ApiError } from '../../../data/client.js';
import * as auth from '../../../data/auth-store.js';
import { moveOutcomeText, moveRefusalText, parseQueueMoveReport, postQueueMove, queueMoveBody, QUEUE_MOVE_PATH } from './queue-move-action.js';
export const report = { v: 1 as const, applied: true, lane: 'devin', moved: [{ id: 'one', fromLane: 'codex-personal', toLane: 'devin', fromTier: 'mid', toTier: 'work' }], skipped: [], verified: true };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('builds bodies with optional tier', () => {
  expect(queueMoveBody('source', 'devin')).toEqual({ fromLane: 'source', lane: 'devin' });
  expect(queueMoveBody('source', 'devin', 'work')).toEqual({ fromLane: 'source', lane: 'devin', tier: 'work' });
});
it('describes moves and skips', () => {
  expect(moveOutcomeText(report)).toBe('moved 1 job to devin');
  expect(moveOutcomeText({ ...report, moved: Array(7).fill(report.moved[0]) })).toBe('moved 7 jobs to devin');
  expect(moveOutcomeText({ ...report, moved: [], skipped: Array(3).fill({ id: 'x', reason: 'job-launched' }) })).toBe('moved 0 jobs (3 skipped)');
});
it.each(['job-not-found', 'job-launched', 'job-parked', 'lane-unknown', 'lane-same', 'lane-down', 'lane-held', 'tier-unknown', 'queue-missing'])('explains %s', reason => {
  expect(moveRefusalText(reason)).toMatch(/\.$/);
  expect(moveRefusalText(reason)).not.toBe('The move was refused.');
});
it('validates the complete response', () => {
  expect(parseQueueMoveReport(report)).toEqual(report);
  for (const value of [null, {}, { ...report, verified: 'yes' }, { ...report, moved: [{}] }, { ...report, skipped: [{}] }, { ...report, applied: null }]) {
    try { parseQueueMoveReport(value); throw new Error('accepted'); } catch (error) { expect(error).toBeInstanceOf(ApiError); expect(error).toHaveProperty('status', 502); }
  }
});
it('preserves coded 404 refusals and explains older servers', async () => {
  vi.spyOn(auth, 'getMutationToken').mockReturnValue('test-only');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'REASSIGN_REFUSED', reason: 'job-not-found' }), { status: 404 }));
  await expect(postQueueMove('source', 'devin')).rejects.toThrow('Job was not found.');
  fetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  await expect(postQueueMove('source', 'devin')).rejects.toThrow('This Phantom server cannot move jobs yet; update the app.');
  expect(fetch).toHaveBeenCalledWith(QUEUE_MOVE_PATH, expect.objectContaining({ method: 'POST' }));
});
