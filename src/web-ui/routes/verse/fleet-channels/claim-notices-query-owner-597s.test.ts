import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the HTTP boundary (apiGet) is mocked; ApiError and narrowClaimNotices stay real.
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../data/client.js')>()),
  apiGet,
}));

import { ApiError } from '../../../data/client.js';
import { claimNoticesQuery } from './claim-notices-query.js';

const PATH = '/api/verse/fleet/control/claim-notices';

// Braces matter: a function returned from beforeEach is run as cleanup.
beforeEach(() => { apiGet.mockReset(); });

describe('claimNoticesQuery.fetch boundary', () => {
  it('requests the exact route and forwards the AbortSignal', async () => {
    apiGet.mockResolvedValue({ v: 1, source: 'ok' });
    const signal = new AbortController().signal;
    await claimNoticesQuery.fetch(signal);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet.mock.calls[0]?.[0]).toBe(PATH);
    expect(apiGet.mock.calls[0]?.[1]).toBe(signal);
  });

  it('keeps delivery unknown for a legacy valid response without delivery evidence, without mutating it', async () => {
    const payload = {
      v: 1, source: 'ok', slackConfigured: true, bindings: 1,
      sent: { total: 1, recent: [{ state: 'sent', claimId: 'fake-claim', at: 100 }] },
    };
    const before = structuredClone(payload);
    apiGet.mockResolvedValue(payload);

    const view = await claimNoticesQuery.fetch(new AbortController().signal);

    expect(view).not.toBeNull();
    expect(view?.recent).toEqual([{ state: 'sent', claimId: 'fake-claim', at: 100, delivery: 'unknown' }]);
    expect(view?.delivery).toEqual({ sendStore: 'unknown', slackSent: 0, noReceipt: 0, unknown: 1 });
    expect(payload).toEqual(before);
  });

  it('returns null for a malformed payload', async () => {
    for (const bad of [null, 'nope', [], { v: 2, source: 'ok' }, { v: 1, source: 'bogus' }]) {
      apiGet.mockResolvedValueOnce(bad);
      expect(await claimNoticesQuery.fetch(new AbortController().signal)).toBeNull();
    }
  });

  it('returns null for an actual ApiError 404 (route absent in this build)', async () => {
    apiGet.mockImplementation(async () => { throw new ApiError('GET failed (HTTP 404)', 404, PATH); });
    expect(await claimNoticesQuery.fetch(new AbortController().signal)).toBeNull();
  });

  it('rethrows non-404 ApiErrors instead of fabricating an empty fleet state', async () => {
    const err = new ApiError('GET failed (HTTP 500)', 500, PATH);
    apiGet.mockImplementation(async () => { throw err; });
    await expect(claimNoticesQuery.fetch(new AbortController().signal)).rejects.toBe(err);
  });

  it('does not treat a plain error with status 404 as a missing route', async () => {
    const err = Object.assign(new Error('fake'), { status: 404 });
    apiGet.mockImplementation(async () => { throw err; });
    await expect(claimNoticesQuery.fetch(new AbortController().signal)).rejects.toBe(err);
  });

  it('rethrows abort failures', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    apiGet.mockImplementation(async () => { throw abort; });
    await expect(claimNoticesQuery.fetch(new AbortController().signal)).rejects.toBe(abort);
  });
});
