import { afterEach, describe, expect, it, vi } from 'vitest';
import { phonePendingQuery } from './phone-pending-query.js';

afterEach(() => vi.unstubAllGlobals());

describe('pending phone query', () => {
  it('narrows rows and does not retain subject or malformed optional fields', async () => {
    const fetcher = vi.fn(async (_path: string) => Response.json({ v: 1, approvals: [
      { id: 'one', label: 'Phone', email: 'fake@example.test', subject: 'fake-credential', deviceType: 'phone' },
      { id: 'two', label: 'Tablet', email: 12, deviceType: null },
      null, {}, { id: 4, label: 'Invalid' }, { id: 'bad', label: false },
    ] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(phonePendingQuery.fetch()).resolves.toEqual([
      { id: 'one', label: 'Phone', email: 'fake@example.test', deviceType: 'phone' },
      { id: 'two', label: 'Tablet', email: undefined, deviceType: undefined },
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/verse/fleet/control/remote-pending');
  });

  it.each([404, 500])('returns null on HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(phonePendingQuery.fetch()).resolves.toBeNull();
  });

  it('returns null on transport failure and malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(Response.json({ approvals: null })));
    await expect(phonePendingQuery.fetch()).resolves.toBeNull();
    await expect(phonePendingQuery.fetch()).resolves.toBeNull();
  });
});
