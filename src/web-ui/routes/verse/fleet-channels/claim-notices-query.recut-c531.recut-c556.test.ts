import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { claimNoticesQuery } from './claim-notices-query.js';

afterEach(() => { vi.unstubAllGlobals(); });

it('recovers delivery evidence after HTTP failures through the real query and client', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ v: 1, source: 'ok', sent: {
      total: 1, recent: [{ state: 'sent', claimId: 'fake-claim', at: 100 }],
    } }))
    .mockResolvedValueOnce(Response.json({ error: 'Fake store unavailable' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ error: 'Fake route absent' }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ v: 1, source: 'ok', sent: {
      total: 1, recent: [{ state: 'sent', claimId: 'fake-claim', at: 100, delivery: 'slack-sent' }],
    }, delivery: { sendStore: 'ok', slackSent: 1, noReceipt: 0, unknown: 0 } }));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const legacy = await claimNoticesQuery.fetch(signal);
  expect(legacy?.delivery).toEqual({ sendStore: 'unknown', slackSent: 0, noReceipt: 0, unknown: 1 });
  await expect(claimNoticesQuery.fetch(signal)).rejects.toMatchObject({
    name: 'ApiError', status: 503, detail: 'Fake store unavailable',
  } satisfies Partial<ApiError>);
  expect(await claimNoticesQuery.fetch(signal)).toBeNull();
  const recovered = await claimNoticesQuery.fetch(signal);
  expect(recovered?.delivery).toEqual({ sendStore: 'ok', slackSent: 1, noReceipt: 0, unknown: 0 });
  expect(recovered?.recent[0].delivery).toBe('slack-sent');
  expect(legacy?.recent[0].delivery).toBe('unknown');
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const [path, init] of fetch.mock.calls) {
    expect(path).toBe('/api/verse/fleet/control/claim-notices');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
});

it('preserves caller cancellation without converting it into missing delivery evidence', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const reason = new DOMException('Fake cancelled read', 'AbortError');
  controller.abort(reason);
  await expect(claimNoticesQuery.fetch(controller.signal)).rejects.toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
});
