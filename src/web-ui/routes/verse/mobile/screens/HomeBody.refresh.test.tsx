import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../../data/cache.js';
import { json, stubFetch } from '../mobile.test-support.js';
import { homeRefreshKeys, refreshHome } from './HomeBody.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('Home refresh', () => {
  it('includes every Home query key', () => {
    expect(new Set(homeRefreshKeys())).toEqual(new Set([
      'verse-control', 'verse-fleet-live', 'verse-bootstrap', 'mobile-fleet-runs', 'verse-resources-cloud',
    ]));
  });

  it('re-requests all reads and settles when the fleet runs read fails', async () => {
    const paths = ['/api/verse/control', '/api/verse/fleet/live', '/api/verse/bootstrap', '/api/verse/fleet/runs', '/api/verse/cloud'];
    const { calls } = stubFetch({
      'GET /api/verse/control': {},
      'GET /api/verse/fleet/live': {},
      'GET /api/verse/bootstrap': {},
      'GET /api/verse/fleet/runs': json({ error: 'Unavailable' }, 500),
      'GET /api/verse/cloud': {},
    });

    await refreshHome();
    await expect(refreshHome()).resolves.toBeDefined();
    for (const path of paths) {
      expect(calls.filter((call) => call.url === path)).toHaveLength(2);
    }
    expect(getQuerySnapshot('mobile-fleet-runs').status).toBe('error');
  });
});
