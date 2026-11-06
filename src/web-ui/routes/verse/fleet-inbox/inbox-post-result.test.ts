import { expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { retryable } from './inbox-post-result.js';
import { postAckLine } from './inbox-post-ack-model.js';

it('formats the inbox time in 24-hour ET and handles invalid timestamps', () => {
  const now = Date.parse('2026-10-31T09:42:00Z');
  expect(postAckLine({ at: '2026-10-31T09:42:00Z' }, null, now)?.text).toBe('Landed 05:42 · waiting for the next leader pass');
  expect(postAckLine({ at: 'invalid' }, null, now)?.text).toBe('Landed · Leader status unknown');
});
it('reports a duplicate without formatting its timestamp', () => {
  expect(postAckLine({ at: 'invalid', duplicate: true }, null, 0)?.text).toBe('Already in the inbox (same text within the dedupe window)');
});
it.each([400, 401, 404, 429, 500, 502, 503, 504])('classifies HTTP %s', status => {
  expect(retryable(new ApiError('failure', status, '/inbox'))).toBe([502, 503, 504].includes(status));
});
it('only retries network failures among other errors', () => {
  expect(retryable(new TypeError('Failed to fetch'))).toBe(true);
  expect(retryable(new VerseMutationLockedError())).toBe(false);
  expect(retryable(new Error('Unconfirmed response'))).toBe(false);
  expect(retryable(null)).toBe(false);
});
