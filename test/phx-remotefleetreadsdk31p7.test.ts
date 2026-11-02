import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FleetBusFeedV1 } from '../src/core/fleet/bus-feed.js';
import type { FleetLiveSnapshotV1 } from '../src/core/fleet/fleet-types.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { RunsSwitchesV1 } from '../src/core/fleet/runs-switches.js';
import type { FleetInboxReadV1 } from '../src/core/verse/fleet-inbox-read.js';
import type { FleetRunsV1 } from '../src/core/verse/fleet-runs-types.js';
import { createRemoteFleetFeed, type RemoteFleetInboxOptions, type RemoteFleetReadOptions } from '../src/core/web/remote-fleet-feed.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

function fixture() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const response = { fixture: 'fake' };
  const feed = createRemoteFleetFeed({
    async get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path });
      return response as T;
    },
    async mutate<T>(method: 'POST', path: string, body: unknown): Promise<T> {
      calls.push({ method, path, body });
      return response as T;
    },
  });
  return { calls, feed, response };
}

describe('remote fleet read adapter', () => {
  it('uses the public projection types', () => {
    const { feed } = fixture();
    expectTypeOf(feed.list()).toEqualTypeOf<Promise<FleetLiveSnapshotV1>>();
    expectTypeOf(feed.runs()).toEqualTypeOf<Promise<FleetRunsV1>>();
    expectTypeOf(feed.laneTargets()).toEqualTypeOf<Promise<LaneTargetsV1>>();
    expectTypeOf(feed.switches()).toEqualTypeOf<Promise<RunsSwitchesV1>>();
    expectTypeOf(feed.inbox()).toEqualTypeOf<Promise<FleetInboxReadV1 | null>>();
    expectTypeOf(feed.queue()).toEqualTypeOf<Promise<FleetQueueV1>>();
    expectTypeOf(feed.bus()).toEqualTypeOf<Promise<FleetBusFeedV1>>();
  });

  it('reads the reviewed paths with encoded optional filters and bounds', async () => {
    const { feed, calls, response } = fixture();
    const results = await Promise.all([
      feed.runs(), feed.laneTargets(), feed.switches(), feed.inbox(), feed.inbox({}),
      feed.inbox({ source: 'Phantom mobile._- 9' }), feed.inbox({ limit: 1, source: 'A' }),
      feed.inbox({ limit: 200, source: 'x'.repeat(40) }),
      feed.queue(), feed.queue({}), feed.queue({ limit: 1 }), feed.queue({ limit: 200 }),
      feed.bus(), feed.bus({}), feed.bus({ limit: 1 }), feed.bus({ limit: 200 }),
    ]);
    expect(results.every((result) => result === response)).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([
      '/api/verse/fleet/runs', '/api/verse/fleet/control/lanes', '/api/verse/fleet/control/switches',
      '/api/verse/fleet/runs/inbox?limit=50', '/api/verse/fleet/runs/inbox?limit=50',
      '/api/verse/fleet/runs/inbox?limit=50&source=Phantom%20mobile._-%209',
      '/api/verse/fleet/runs/inbox?limit=1&source=A',
      `/api/verse/fleet/runs/inbox?limit=200&source=${'x'.repeat(40)}`,
      '/api/verse/fleet/live/queue', '/api/verse/fleet/live/queue',
      '/api/verse/fleet/live/queue?limit=1', '/api/verse/fleet/live/queue?limit=200',
      '/api/verse/fleet/live/bus', '/api/verse/fleet/live/bus',
      '/api/verse/fleet/live/bus?limit=1', '/api/verse/fleet/live/bus?limit=200',
    ]);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(Object.keys(call)).toEqual(['method', 'path']);
      expect(classifyRemoteRoute(call.method, call.path).kind).toBe('read');
    }
  });

  it('rejects invalid options before any transport call', () => {
    const { feed, calls } = fixture();
    for (const limit of [0, -1, 201, 1.5, NaN, Infinity, '1', null]) {
      for (const read of [feed.inbox, feed.queue, feed.bus]) {
        expect(() => read({ limit } as RemoteFleetReadOptions)).toThrow();
      }
    }
    for (const source of ['', 'x'.repeat(41), 'a/b', 'a&limit=1', 'line\nbreak', 'é', 1, null]) {
      expect(() => feed.inbox({ source } as RemoteFleetInboxOptions)).toThrow();
    }
    for (const options of [null, [], 'bad', { extra: 1 }, { body: 'fake' }]) {
      for (const read of [feed.inbox, feed.queue, feed.bus]) {
        expect(() => read(options as RemoteFleetInboxOptions)).toThrow();
      }
    }
    expect(() => feed.queue({ source: 'fake' } as RemoteFleetReadOptions)).toThrow();
    expect(() => feed.bus({ source: 'fake' } as RemoteFleetReadOptions)).toThrow();
    expect(calls).toEqual([]);
  });

  it('preserves list and the three existing control calls', async () => {
    const { feed, calls, response } = fixture();
    expect(await feed.list()).toBe(response);
    expect(await feed.pause()).toBe(response);
    expect(await feed.resume()).toBe(response);
    expect(await feed.kill()).toBe(response);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/verse/fleet/live' },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } },
      { method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } },
    ]);
  });
});
