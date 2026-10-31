import { beforeEach, expect, it, vi } from 'vitest';
import { getMutationToken } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import { applySelfUpdate } from './update-apply-client.js';

vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn() }));
vi.mock('../../../data/client.js', async (original) => ({ ...await original<typeof import('../../../data/client.js')>(), apiPost: vi.fn() }));
beforeEach(() => { vi.mocked(getMutationToken).mockReturnValue('test-only'); });
const valid = { name: 'fetch', ok: true, ms: 1200, note: null };

it.each(['updated', 'already-current', 'refused', 'failed'])('preserves valid steps for %s', async (outcome) => {
  vi.mocked(apiPost).mockResolvedValue({ outcome, toCommit: 'abcdef123', reason: 'reason', restart: { mode: 'manual' }, steps: [valid, { name: 'update', ok: false, ms: 0, note: 'failed' }] });
  expect(await applySelfUpdate()).toMatchObject({ kind: outcome, steps: [valid, { name: 'update', ok: false, ms: 0, note: 'failed' }] });
});
it('drops malformed rows without losing valid ones', async () => {
  const invalid = [null, [], {}, { ...valid, name: 'Fetch' }, { ...valid, name: '' }, { ...valid, name: 'x'.repeat(21) },
    { ...valid, ok: 1 }, { ...valid, ms: -1 }, { ...valid, ms: Infinity }, { ...valid, ms: NaN },
    { ...valid, ms: '1' }, { ...valid, note: undefined }, { ...valid, note: 'x'.repeat(401) }];
  const boundary = { name: 'a'.repeat(20), ok: false, ms: 1.5, note: 'x'.repeat(400) };
  vi.mocked(apiPost).mockResolvedValue({ outcome: 'failed', restart: {}, steps: [valid, ...invalid, boundary] });
  expect(await applySelfUpdate()).toMatchObject({ kind: 'failed', steps: [valid, boundary] });
});
it.each([undefined, null, 'steps'])('tolerates absent or non-array steps: %s', async (steps) => {
  vi.mocked(apiPost).mockResolvedValue({ outcome: 'already-current', restart: {}, steps });
  expect(await applySelfUpdate()).toEqual({ kind: 'already-current' });
});
