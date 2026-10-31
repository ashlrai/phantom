import { beforeEach, expect, it, vi } from 'vitest';
import { getMutationToken } from '../../../data/auth-store.js';
import { apiPost, ApiError } from '../../../data/client.js';
import { applySelfUpdate } from './update-apply-client.js';
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn() }));
vi.mock('../../../data/client.js', async (original) => ({ ...await original<typeof import('../../../data/client.js')>(), apiPost: vi.fn() }));
beforeEach(() => { vi.mocked(getMutationToken).mockReturnValue('test-only'); });
it('posts apply with mutation authority and maps updated', async () => {
  vi.mocked(apiPost).mockResolvedValue({ outcome: 'updated', toCommit: 'abcdef123', restart: { mode: 'sidecar-supervised' } });
  expect(await applySelfUpdate()).toEqual({ kind: 'updated', toCommit: 'abcdef123', restart: 'sidecar' });
  expect(apiPost).toHaveBeenCalledWith('/api/verse/ops/self-update', { action: 'apply' }, 'test-only');
});
it.each([[409, 'busy', 'busy'], [404, 'missing', 'not-in-build'], [400, 'expected {action:"fetch"}', 'not-in-build']])('maps HTTP %s', async (status, message, kind) => {
  vi.mocked(apiPost).mockRejectedValue(new ApiError(message, status, '/api/verse/ops/self-update'));
  expect(await applySelfUpdate()).toEqual({ kind });
});
it('does not post without mutation authority', async () => {
  vi.mocked(getMutationToken).mockReturnValue(null);
  expect(await applySelfUpdate()).toEqual({ kind: 'locked' });
  expect(apiPost).not.toHaveBeenCalled();
});
it.each([null, { outcome: 'unknown', restart: {} }, { outcome: 'updated', restart: {} }])('rejects malformed success: %j', async (value) => {
  vi.mocked(apiPost).mockResolvedValue(value);
  expect(await applySelfUpdate()).toMatchObject({ kind: 'failed' });
});
it.each(['already-current', 'refused', 'failed'] as const)('maps %s', async (outcome) => {
  vi.mocked(apiPost).mockResolvedValue({ outcome, reason: 'Local changes', restart: {} });
  expect(await applySelfUpdate()).toEqual(outcome === 'already-current' ? { kind: outcome } : { kind: outcome, reason: 'Local changes' });
});
it('maps a manual restart', async () => {
  vi.mocked(apiPost).mockResolvedValue({ outcome: 'updated', toCommit: 'abcdef123', restart: { mode: 'manual' } });
  expect(await applySelfUpdate()).toEqual({ kind: 'updated', toCommit: 'abcdef123', restart: 'manual' });
});
it('keeps unrelated HTTP failures distinct from unsupported builds', async () => {
  vi.mocked(apiPost).mockRejectedValue(new ApiError('Bad request', 400, '/api/verse/ops/self-update'));
  expect(await applySelfUpdate()).toMatchObject({ kind: 'failed' });
});
