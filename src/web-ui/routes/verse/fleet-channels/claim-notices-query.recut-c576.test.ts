import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticesQuery } from './claim-notices-query.js';

afterEach(() => { vi.unstubAllGlobals(); });

it('keeps aggregate delivery evidence independent of capped rows through the real HTTP query', async () => {
  const payload = {
    v: 1, source: 'unreadable', bindings: 1,
    sent: { total: 40, recent: Array.from({ length: 25 }, (_, i) => ({
      state: 'sent', claimId: `fake-claim-${i}`, at: 100 + i, delivery: 'slack-sent',
    })) },
    delivery: { sendStore: 'degraded', slackSent: 30, noReceipt: 7, unknown: 3 },
  };
  const fetch = vi.fn().mockResolvedValue(Response.json(payload));
  vi.stubGlobal('fetch', fetch);

  const view = await claimNoticesQuery.fetch(new AbortController().signal);

  expect(view?.source).toBe('unreadable');
  expect(view?.sentTotal).toBe(40);
  expect(view?.recent).toHaveLength(20);
  expect(view?.recent.at(-1)?.claimId).toBe('fake-claim-19');
  expect(view?.delivery).toEqual(payload.delivery);
  expect(fetch).toHaveBeenCalledTimes(1);
});
