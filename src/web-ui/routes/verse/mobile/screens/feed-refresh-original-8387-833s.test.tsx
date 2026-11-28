import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot, runQuery } from '../../../../data/cache.js';
import { fleetMergesQuery } from '../../fleet-merges/fleet-merges-queries.js';
import { leaderThreadQuery } from '../../leader/thread-data.js';
import { ownerThreadQuery } from '../../leader-thread/owner-thread-queries.js';
import { updateStatusQuery } from '../../sections/update-status-queries.js';
import { stubFetch, json } from '../mobile.test-support.js';
import { refreshFeedScreen } from './FeedScreen.js';

const queries = [leaderThreadQuery, fleetMergesQuery, ownerThreadQuery, updateStatusQuery];
const routes = {
  'GET /api/verse/leader/thread': { messages: [] },
  'GET /api/verse/fleet/runs': { events: [] },
  'GET /api/verse/comms/owner-thread': { schema: 'comms.owner-thread.v1', messages: [] },
  'GET /api/verse/ops/self-update': () => json({}, 404),
};
const paths = Object.keys(routes).map((route) => route.slice(4)).sort();
const calledPaths = (calls: { url: string }[]) => calls.map(({ url }) => url.split('?')[0]).sort();

afterEach(() => {
  evictAll();
  document.head.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('refreshFeedScreen original #8387', () => {
  it('refreshes exactly the four local sources through their real queries', async () => {
    const { calls } = stubFetch(routes);
    await refreshFeedScreen();
    expect(calledPaths(calls)).toEqual(paths);
    for (const query of queries) expect(getQuerySnapshot(query.key).status).toBe('success');
  });

  it('refreshes only leader and fleet in remote mode', async () => {
    document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
    const { calls } = stubFetch(routes);
    await refreshFeedScreen();
    expect(calledPaths(calls)).toEqual(['/api/verse/fleet/runs', '/api/verse/leader/thread']);
    expect(getQuerySnapshot(ownerThreadQuery.key).status).toBe('idle');
    expect(getQuerySnapshot(updateStatusQuery.key).status).toBe('idle');
  });

  it('forces a new read with cached data and an in-flight read', async () => {
    const { calls } = stubFetch(routes);
    await refreshFeedScreen();
    calls.length = 0;
    let finish!: () => void;
    const pending = runQuery(leaderThreadQuery.key, () => new Promise<void>((resolve) => { finish = resolve; }));
    await refreshFeedScreen();
    expect(calledPaths(calls)).toEqual(paths);
    expect(getQuerySnapshot(leaderThreadQuery.key).status).toBe('success');
    finish();
    await pending;
  });

  it('settles and refreshes the other sources when one fetch rejects', async () => {
    const { calls } = stubFetch({ ...routes, 'GET /api/verse/fleet/runs': () => { throw new Error('synthetic failure'); } });
    await expect(refreshFeedScreen()).resolves.toHaveLength(4);
    expect(calledPaths(calls)).toEqual(paths);
    expect(getQuerySnapshot(fleetMergesQuery.key).status).toBe('error');
    for (const query of [leaderThreadQuery, ownerThreadQuery, updateStatusQuery]) {
      expect(getQuerySnapshot(query.key).status).toBe('success');
    }
  });
});
