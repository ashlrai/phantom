import { afterEach, describe, expect, it, vi } from 'vitest';
import { mainHealthQuery } from './main-health-query.js';

const repo = { repo: 'phantom', branch: 'master', sha: 'abcdef0123', state: 'red', checkedAt: null,
  failingCheck: null, fixJobs: [], nightlyRed: null };
const data = { v: 1, generatedAt: '2026-11-01T00:00:00Z', source: 'ok', statusAt: null,
  stale: false, guardianOff: false, red: 1, repos: [repo] };
afterEach(() => vi.unstubAllGlobals());

describe('main health query', () => {
  it('reads the pinned route and shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await mainHealthQuery.fetch()).toEqual({ kind: 'available', data });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/verse/runs-history/main-health');
  });
  it('treats 404 as not in build', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    expect(await mainHealthQuery.fetch()).toEqual({ kind: 'notInBuild' });
  });
  it.each([{ ...data, red: -1 }, { ...data, repos: [{ ...repo, fixJobs: [1] }] }, { ...data, stale: 'yes' }])
    ('rejects an invalid payload', async invalid => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid))));
      expect(await mainHealthQuery.fetch()).toEqual({ kind: 'notInBuild' });
    });
});
