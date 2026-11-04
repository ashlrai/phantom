import { afterEach, describe, expect, it, vi } from 'vitest';

const { reportSessionExpired } = vi.hoisted(() => ({ reportSessionExpired: vi.fn() }));
vi.mock('../../../data/auth-store.js', () => ({ getReadClientProof: () => 'proof', reportSessionExpired }));
import { stuckFixesQuery } from './stuck-fixes-query.js';

const fix = { job: 'FIXUP-MAIN-1', repo: 'phantom', prUrl: 'https://github.com/ashlrai/phantom/pull/42',
  publishedAt: '2026-11-04T10:00:00Z', ageMinutes: 75 };
const data = { v: 1, generatedAt: '2026-11-04T11:15:00Z', known: true, thresholdMinutes: 30, stuck: [fix] };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('stuck fixes query', () => {
  it('reads the pinned route and shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await stuckFixesQuery.fetch()).toEqual({ kind: 'available', data });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/verse/runs-history/stuck-fixes');
    expect(stuckFixesQuery.key).toBe('verse-runs-history-stuck-fixes');
  });
  it('treats 404 as not in build', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    expect(await stuckFixesQuery.fetch()).toEqual({ kind: 'notInBuild' });
    expect(reportSessionExpired).not.toHaveBeenCalled();
  });
  it('reports an expired session on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    expect(await stuckFixesQuery.fetch()).toEqual({ kind: 'notInBuild' });
    expect(reportSessionExpired).toHaveBeenCalledOnce();
  });
  it.each([
    ['negative age', { ...data, stuck: [{ ...fix, ageMinutes: -1 }] }],
    ['fractional age', { ...data, stuck: [{ ...fix, ageMinutes: 1.5 }] }],
    ['non-github url', { ...data, stuck: [{ ...fix, prUrl: 'https://evil.example/pull/1' }] }],
    ['wrong version', { ...data, v: 2 }],
    ['known not boolean', { ...data, known: 'yes' }],
  ])('rejects an invalid payload: %s', async (_name, invalid) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid))));
    expect(await stuckFixesQuery.fetch()).toEqual({ kind: 'notInBuild' });
  });
});
