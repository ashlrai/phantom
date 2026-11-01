import { afterEach, expect, it, vi } from 'vitest';
import { busTellPrefill, requestBusPost, subscribeBusPostRequest, takeBusPostRequest } from './bus-post-request.js';

afterEach(() => { takeBusPostRequest(); });

it('notifies subscribers and takes the latest request once', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeBusPostRequest(listener);
  requestBusPost({ to: 'first', quote: 'first', text: '' });
  const request = { to: 'second', quote: 'second', text: '' };
  requestBusPost(request);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(takeBusPostRequest()).toEqual(request);
  expect(takeBusPostRequest()).toBeNull();
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
  requestBusPost(request);
  expect(listener).toHaveBeenCalledTimes(3);
});

it('quotes only the job state and PR, with a fallback when no PR exists', () => {
  const detail = { state: 'running', publish: { prUrl: 'https://example.com/pr/1' }, log: { tail: ['private log text'] } };
  expect(busTellPrefill('RQ-1', detail)).toEqual({ to: 'RQ-1', quote: 'RQ-1 · running · https://example.com/pr/1', text: '' });
  expect(busTellPrefill('RQ-1', { state: 'running' }).quote).toBe('RQ-1 · running · no PR yet');
  expect(JSON.stringify(busTellPrefill('RQ-1', detail))).not.toContain('private log text');
  expect(busTellPrefill('RQ-1', undefined).quote).toBe('RQ-1 · unknown · no PR yet');
});
