import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from '../../../data/client.js';
import { updateStatusQuery } from './update-status-queries.js';
const validBase = Object.freeze({
  v: 1, sourceState: 'degraded' as const,
  installedVersion: '1.0.0', headSha: 'abcdef12', headAt: '2025-01-01T00:00:00Z',
  originSha: '1234abcd', branch: 'main', behind: 3, ahead: 0,
  dirty: false, lastFetchAt: '2025-01-01T00:00:00Z',
  processStartedAt: '2025-01-01T00:00:00Z', uptimeSeconds: 120,
});
const validPayload = (can: boolean | null) => ({ ...validBase, canFastForward: can });
vi.mock('../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(),
}));
beforeEach(() => { vi.mocked(apiGet).mockReset(); });
it('returns payload when canFastForward is true', async () => {
  vi.mocked(apiGet).mockResolvedValue(validPayload(true));
  expect(await updateStatusQuery.fetch()).toEqual(validPayload(true));
});
it('returns payload when canFastForward is false', async () => {
  vi.mocked(apiGet).mockResolvedValue(validPayload(false));
  expect(await updateStatusQuery.fetch()).toEqual(validPayload(false));
});
it('returns payload when canFastForward is null', async () => {
  vi.mocked(apiGet).mockResolvedValue(validPayload(null));
  expect(await updateStatusQuery.fetch()).toEqual(validPayload(null));
});
it('throws Invalid update status when canFastForward is the string "yes"', async () => {
  vi.mocked(apiGet).mockResolvedValue(validPayload('yes' as unknown as boolean));
  await expect(updateStatusQuery.fetch()).rejects.toThrow('Invalid update status');
});
it('throws Invalid update status when canFastForward is missing', async () => {
  const bad = { ...validBase };
  delete (bad as Record<string, unknown>)['canFastForward'];
  vi.mocked(apiGet).mockResolvedValue(bad);
  await expect(updateStatusQuery.fetch()).rejects.toThrow('Invalid update status');
});
it('maps 404 to notInBuild', async () => {
  vi.mocked(apiGet).mockRejectedValue(new ApiError('Not found', 404, '/api/verse/ops/self-update'));
  expect(await updateStatusQuery.fetch()).toEqual({ kind: 'notInBuild' });
});
