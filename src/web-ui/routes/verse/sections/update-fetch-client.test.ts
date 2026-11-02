import { beforeEach, expect, it, vi } from 'vitest';
import { getMutationToken } from '../../../data/auth-store.js';
import { apiPost, ApiError } from '../../../data/client.js';
import { fetchOriginNow } from './update-fetch-client.js';

vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn() }));
vi.mock('../../../data/client.js', async (original) => ({ ...await original<typeof import('../../../data/client.js')>(), apiPost: vi.fn() }));
beforeEach(() => { vi.mocked(getMutationToken).mockReturnValue('test-only'); });
it('posts fetch with mutation authority and returns the fetch time', async () => {
  vi.mocked(apiPost).mockResolvedValue({ ok: true, action: 'fetch', fetchedAt: '2026-01-01T00:00:00Z' });
  expect(await fetchOriginNow()).toEqual({ kind: 'fetched', at: '2026-01-01T00:00:00Z' });
  expect(apiPost).toHaveBeenCalledWith('/api/verse/ops/self-update', { action: 'fetch' }, 'test-only');
});
it('does not post without mutation authority', async () => {
  vi.mocked(getMutationToken).mockReturnValue(null);
  expect(await fetchOriginNow()).toEqual({ kind: 'locked' });
  expect(apiPost).not.toHaveBeenCalled();
});
it('maps a 404 to an unsupported build', async () => {
  vi.mocked(apiPost).mockRejectedValue(new ApiError('missing', 404, '/api/verse/ops/self-update'));
  expect(await fetchOriginNow()).toEqual({ kind: 'not-in-build' });
});
it.each([null, { ok: false, reason: 'private detail' }, { ok: true, action: 'fetch', fetchedAt: null }])('rejects unsuccessful or malformed bodies', async (body) => {
  vi.mocked(apiPost).mockResolvedValue(body);
  expect(await fetchOriginNow()).toEqual({ kind: 'failed', reason: 'Could not fetch origin. Try again.' });
});
it('does not expose transport errors', async () => {
  vi.mocked(apiPost).mockRejectedValue(new Error('private detail'));
  expect(await fetchOriginNow()).toEqual({ kind: 'failed', reason: 'Could not fetch origin. Try again.' });
});
