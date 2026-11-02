import { describe, expect, it } from 'vitest';
import type { FleetBusFeedV1 } from '../src/core/fleet/bus-feed.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { FleetInboxReadV1 } from '../src/core/verse/fleet-inbox-read.js';
import type { FleetRunsV1 } from '../src/core/verse/fleet-runs-types.js';
import { createRemoteFleetFeed, type RemoteFleetTransport } from '../src/core/web/remote-fleet-feed.js';
import { checkRemoteEnvelope, classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';

const origin = 'https://phone.example.test';
const csrf = 'fake-csrf-proof';
const generatedAt = '2026-10-31T00:12:00.000Z';

const runs: FleetRunsV1 = {
  v: 1, generatedAt,
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: generatedAt, paused: false, memFreePct: 60, diskFreeGb: 100, switches: [], claudeLane: null,
  host: null, lanes: [], workers: [{ job: 'job-1', repo: 'example/project', lane: 'default', tier: 'standard', ageSeconds: 10 }],
  leaders: [], orchestratorAgents: 1, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const inbox: FleetInboxReadV1 = {
  v: 1, generatedAt, sourceState: 'healthy', limit: 12, source: 'phone agent', dropped: 0,
  entries: [{ at: generatedAt, source: 'phone agent', priority: null, text: 'Inspect job-1' }],
};
const bus: FleetBusFeedV1 = {
  v: 1, hops: [{ id: 'hop-1', from: 'phone', to: 'agent', inputTokens: 5, outputTokens: 2 }],
  hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' },
};
const queue: FleetQueueV1 = {
  v: 1, generatedAt, sources: { ready: 'healthy', skips: 'healthy' }, total: 1, ready: 1, parked: 0,
  malformed: 0, byLane: [{ lane: 'default', ready: 1, parked: 0 }], groups: [], skips: [], skipsLast24h: 0,
};

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Gateway ${status}: ${code}`);
  }
}

type Request = { method: string; path: string; body?: unknown };

/** In-memory gateway: pairing is a fixture state, not an authentication implementation. */
function pairedGateway() {
  let paired = true;
  const requests: Request[] = [];
  const forwarded: Request[] = [];
  const payloads: Record<string, unknown> = {
    '/api/verse/fleet/runs': runs,
    '/api/verse/fleet/runs/inbox': inbox,
    '/api/verse/fleet/live/bus': bus,
    '/api/verse/fleet/live/queue': queue,
  };

  async function dispatch(method: string, path: string, body?: unknown): Promise<unknown> {
    const request = { method, path, ...(body === undefined ? {} : { body }) };
    requests.push(request);
    const envelope = checkRemoteEnvelope({ method, headers: {
      host: 'phone.example.test', origin, ...(method === 'POST' ? { 'x-ashlr-remote-csrf': csrf } : {}),
    } }, origin, csrf);
    if (!envelope.ok) throw new GatewayError(403, `ENVELOPE_${envelope.reason}`);
    const route = classifyRemoteRoute(method, path);
    if (route.kind === 'deny' || route.kind === 'stream') throw new GatewayError(404, 'ROUTE_DENIED');
    if (!paired) throw new GatewayError(401, 'DEVICE_SESSION_REQUIRED');
    if (route.kind === 'write') {
      if (!validateRemoteMutation(route, body)) throw new GatewayError(400, 'INVALID_BODY');
      if (route.stepUp) throw new GatewayError(403, 'STEP_UP_REQUIRED');
      throw new Error('Unexpected permitted mutation');
    }
    if (!Object.hasOwn(payloads, route.path)) throw new Error(`Unexpected read: ${route.path}`);
    forwarded.push(request);
    return payloads[route.path];
  }

  const transport: RemoteFleetTransport = {
    async get<T>(path: string): Promise<T> { return await dispatch('GET', path) as T; },
    async mutate<T>(method: 'POST', path: string, body: unknown): Promise<T> {
      return await dispatch(method, path, body) as T;
    },
  };
  return { feed: createRemoteFleetFeed(transport), requests, forwarded, revoke: () => { paired = false; } };
}

describe('3.30 remote fleet failure qualification', () => {
  it.each([
    { name: 'runs', read: (feed: ReturnType<typeof createRemoteFleetFeed>) => feed.runs(), expected: runs,
      path: '/api/verse/fleet/runs' },
    { name: 'inbox', read: (feed: ReturnType<typeof createRemoteFleetFeed>) => feed.inbox({ limit: 12, source: 'phone agent' }), expected: inbox,
      path: '/api/verse/fleet/runs/inbox?limit=12&source=phone%20agent' },
    { name: 'bus', read: (feed: ReturnType<typeof createRemoteFleetFeed>) => feed.bus({ limit: 12 }), expected: bus,
      path: '/api/verse/fleet/live/bus?limit=12' },
    { name: 'queue', read: (feed: ReturnType<typeof createRemoteFleetFeed>) => feed.queue({ limit: 12 }), expected: queue,
      path: '/api/verse/fleet/live/queue?limit=12' },
  ])('propagates revocation on $name after a successful paired read', async ({ read, expected, path }) => {
    const gateway = pairedGateway();
    expect(await read(gateway.feed)).toEqual(expected);
    expect(gateway.forwarded).toEqual([{ method: 'GET', path }]);

    gateway.revoke();
    await expect(read(gateway.feed)).rejects.toMatchObject({
      status: 401, code: 'DEVICE_SESSION_REQUIRED', message: 'Gateway 401: DEVICE_SESSION_REQUIRED',
    });
    expect(gateway.requests).toEqual([{ method: 'GET', path }, { method: 'GET', path }]);
    expect(gateway.forwarded).toEqual([{ method: 'GET', path }]);
  });

  it('propagates a denied pause without reporting success or trying a loopback route', async () => {
    const gateway = pairedGateway();
    await expect(gateway.feed.pause()).rejects.toMatchObject({
      status: 403, code: 'STEP_UP_REQUIRED', message: 'Gateway 403: STEP_UP_REQUIRED',
    });
    expect(gateway.requests).toEqual([
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } },
    ]);
    expect(gateway.forwarded).toEqual([]);
  });
});
