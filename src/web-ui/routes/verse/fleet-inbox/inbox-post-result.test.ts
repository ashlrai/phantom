import { expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { postResultText, retryable } from './inbox-post-result.js';

it('formats the local time in 24-hour form', () => {
  const at = new Date(2026, 9, 31, 5, 42).toISOString();
  expect(postResultText({ at, duplicate: false }, 'en-US')).toBe('Sent · 05:42');
  expect(postResultText({ at: 'invalid', duplicate: false })).toBe('Sent');
});
it('reports a duplicate without formatting its timestamp', () => {
  expect(postResultText({ at: 'invalid', duplicate: true })).toBe('Already in the inbox · sent within the last 10 minutes');
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
