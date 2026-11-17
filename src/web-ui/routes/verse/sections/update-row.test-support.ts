import { afterEach, expect, vi } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { fleetLive } from '../command/fixtures.test-support.js';

let calls: [RequestInfo | URL, RequestInit?][] = [];
afterEach(() => {
  for (const [input, init] of calls) {
    if (String(input) !== '/api/verse/ops/self-update') {
      expect([['GET', '/api/fleet/release-chain'], ['GET', '/api/verse/fleet/runs'], ['GET', '/api/verse/fleet/live']]).toContainEqual([init?.method, String(input)]);
    }
  }
  calls = [];
});

/** Keep update request ordering independent of the row's auxiliary reads. */
export function installUpdateFetch(reply: (init?: RequestInit) => Promise<Response>) {
  const statusRequests = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => reply(init));
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/verse/ops/self-update') return statusRequests(input, init);
    if (init?.method !== 'GET') throw new Error(`Unexpected update mutation: ${input}`);
    if (String(input) === '/api/fleet/release-chain') return Promise.resolve(Response.json({}, { status: 404 }));
    if (String(input) === '/api/verse/fleet/runs') return Promise.resolve(Response.json(fleetRunsFixture()));
    if (String(input) === '/api/verse/fleet/live') return Promise.resolve(Response.json(fleetLive('dark')));
    throw new Error(`Unexpected update read: ${input}`);
  });
  calls = fetcher.mock.calls;
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, statusRequests };
}
