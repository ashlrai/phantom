/** Recipe proof for docs/remote-agent-transport-330.md: the production feed
 * drives a recording transport that applies the real gateway gate decisions. */
import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import type { FleetBusFeedV1 } from '../src/core/fleet/bus-feed.js';
import type { FleetLiveSnapshotV1 } from '../src/core/fleet/fleet-types.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { RunsSwitchesV1 } from '../src/core/fleet/runs-switches.js';
import type { FleetInboxReadV1 } from '../src/core/verse/fleet-inbox-read.js';
import type { FleetRunsV1 } from '../src/core/verse/fleet-runs-types.js';
import { createRemoteFleetFeed, type RemoteFleetTransport } from '../src/core/web/remote-fleet-feed.js';
import { checkRemoteEnvelope, classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';

const ORIGIN = 'https://phone.example.test';
const CSRF = 'fake-csrf-proof';
const generatedAt = '2026-10-31T00:12:00.000Z';

const live: FleetLiveSnapshotV1 = {
  v: 1, generatedAt, state: 'paused', stateReason: 'daemon.paused sentinel set', lastActivityAt: generatedAt,
  summary: { building: 0, queued: 2, parked: 0, waitingVerify: 0, mergedToday: 1, revertsToday: 0,
    merged7d: 4, postMergeGreenPct7d: 100, cycleTimeP50Ms7d: 3_600_000 },
  lanes: [{ lane: 'codex', slots: 2, busy: 0, capReason: null }],
  runs: [{ id: 'job-1', taskId: null, repo: 'example/project', title: 'Bridge run', lane: 'codex',
    seatId: null, engine: 'codex', model: null, phase: 'queued', startedAt: generatedAt,
    phaseStartedAt: generatedAt, endedAt: null, outcome: null, prNumber: null, hold: null, seatDecision: null }],
  funnel: null, repos: [],
};
const runs: FleetRunsV1 = {
  v: 1, generatedAt,
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: generatedAt, paused: true, memFreePct: 60, diskFreeGb: 100, switches: [], claudeLane: null,
  host: null, lanes: [], workers: [], leaders: [], orchestratorAgents: 1, publishesLastHour: [],
  mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const laneTargets: LaneTargetsV1 = {
  v: 1, generatedAt, sourceState: 'healthy',
  lanes: [{ lane: 'codex-personal', target: 2, floor: 0, ceiling: 8, held: false,
    heldReason: null, heldUntil: null, lastChange: null, changedBy: null }],
};
const switches: RunsSwitchesV1 = {
  v: 1, sourceState: 'healthy',
  switches: [{ id: 'PAUSE', on: true, since: generatedAt,
    effect: 'No new jobs launch. Running jobs finish.' }],
};
const inbox: FleetInboxReadV1 = {
  v: 1, generatedAt, sourceState: 'healthy', limit: 12, source: 'agent bridge', dropped: 0,
  entries: [{ at: generatedAt, source: 'agent bridge', priority: null, text: 'Inspect job-1' }],
};
const queue: FleetQueueV1 = {
  v: 1, generatedAt, sources: { ready: 'healthy', skips: 'healthy' }, total: 1, ready: 1, parked: 0,
  malformed: 0, byLane: [{ lane: 'default', ready: 1, parked: 0 }], groups: [], skips: [], skipsLast24h: 0,
};
const bus: FleetBusFeedV1 = {
  v: 1, hops: [{ id: 'hop-1', from: 'agent', to: 'leader', inputTokens: 5, outputTokens: 2 }],
  hopsDropped: 0, lastHopAt: generatedAt, events: [], sources: { hops: 'healthy', events: 'healthy' },
};

class GateError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(detail ? `Gateway ${status}: ${code} (${detail})` : `Gateway ${status}: ${code}`);
    this.name = 'GateError';
  }
}

type Request = { method: string; path: string; body?: unknown };

/** In-memory stand-in for startRemoteReadGateway: same envelope, device,
 * route, step-up and body decisions, without sockets. `stepUp()` models a
 * completed WebAuthn ceremony bound to one operation's exact bytes. */
function recordingGateway(options: { localToken?: string } = {}) {
  let paired = true;
  const requests: Request[] = [];
  const forwarded: Request[] = [];
  const approved: Request[] = [];
  const payloads: Record<string, unknown> = {
    '/api/verse/fleet/live': live,
    '/api/verse/fleet/runs': runs,
    '/api/verse/fleet/control/lanes': laneTargets,
    '/api/verse/fleet/control/switches': switches,
    '/api/verse/fleet/runs/inbox': inbox,
    '/api/verse/fleet/live/queue': queue,
    '/api/verse/fleet/live/bus': bus,
  };

  async function dispatch(method: string, path: string, body?: unknown): Promise<unknown> {
    const request: Request = { method, path, ...(body === undefined ? {} : { body }) };
    requests.push(request);
    const envelope = checkRemoteEnvelope({ method, headers: {
      host: 'phone.example.test', origin: ORIGIN,
      ...(method === 'POST' ? { 'x-ashlr-remote-csrf': CSRF } : {}),
      ...(options.localToken === undefined ? {} : { 'x-ashlr-token': options.localToken }),
    } }, ORIGIN, CSRF);
    if (!envelope.ok) throw new GateError(403, 'REMOTE_ENVELOPE_DENIED', envelope.reason);
    if (!paired) throw new GateError(401, 'DEVICE_SESSION_REQUIRED');
    const route = classifyRemoteRoute(method, path);
    if (route.kind !== 'read' && route.kind !== 'write') throw new GateError(404, 'ROUTE_DENIED');
    if (route.kind === 'read') {
      if (!Object.hasOwn(payloads, route.path)) throw new Error(`Unexpected reviewed read: ${route.path}`);
      forwarded.push(request);
      return payloads[route.path];
    }
    if (route.stepUp) {
      const bound = approved.findIndex((op) => op.method === request.method && op.path === request.path
        && isDeepStrictEqual(op.body, request.body));
      if (bound < 0) throw new GateError(403, 'STEP_UP_REQUIRED');
      approved.splice(bound, 1);
    }
    if (!validateRemoteMutation(route, body)) throw new GateError(400, 'INVALID_MUTATION');
    forwarded.push(request);
    return { ok: true };
  }

  const transport: RemoteFleetTransport = {
    async get<T>(path: string): Promise<T> { return await dispatch('GET', path) as T; },
    async mutate<T>(method: 'POST', path: string, body: unknown): Promise<T> {
      return await dispatch(method, path, body) as T;
    },
  };
  return {
    feed: createRemoteFleetFeed(transport), requests, forwarded,
    revoke: () => { paired = false; },
    stepUp: (operation: Request) => { approved.push(operation); },
  };
}

describe('3.30 remote agent recipe', () => {
  it('reads every fleet projection through a reviewed GET route', async () => {
    const gateway = recordingGateway();
    const { feed } = gateway;
    expect(await feed.list()).toEqual(live);
    expect(await feed.runs()).toEqual(runs);
    expect(await feed.laneTargets()).toEqual(laneTargets);
    expect(await feed.switches()).toEqual(switches);
    expect(await feed.inbox({ limit: 12, source: 'agent bridge' })).toEqual(inbox);
    expect(await feed.queue({ limit: 25 })).toEqual(queue);
    expect(await feed.bus()).toEqual(bus);
    const expected = [
      '/api/verse/fleet/live',
      '/api/verse/fleet/runs',
      '/api/verse/fleet/control/lanes',
      '/api/verse/fleet/control/switches',
      '/api/verse/fleet/runs/inbox?limit=12&source=agent%20bridge',
      '/api/verse/fleet/live/queue?limit=25',
      '/api/verse/fleet/live/bus',
    ].map((path) => ({ method: 'GET', path }));
    expect(gateway.requests).toEqual(expected);
    expect(gateway.forwarded).toEqual(expected);
    for (const { method, path } of gateway.forwarded) {
      expect(classifyRemoteRoute(method, path), path)
        .toEqual({ kind: 'read', path: path.split('?')[0] });
    }
  });

  it('returns every step-up denial to the caller without forwarding', async () => {
    const gateway = recordingGateway();
    await expect(gateway.feed.pause()).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    await expect(gateway.feed.resume()).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    await expect(gateway.feed.kill()).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(gateway.requests).toEqual([
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } },
      { method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } },
    ]);
    expect(gateway.forwarded).toEqual([]);
  });

  it('forwards a mutation only after step-up bound to its exact bytes', async () => {
    const gateway = recordingGateway();
    gateway.stepUp({ method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } });
    await expect(gateway.feed.resume()).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    await gateway.feed.pause();
    expect(gateway.forwarded).toEqual([
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } },
    ]);
    await expect(gateway.feed.pause()).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(gateway.forwarded).toHaveLength(1);
  });

  it('resume un-pauses dispatch only; only kill() reaches Stop authority', async () => {
    const gateway = recordingGateway();
    await expect(gateway.feed.resume()).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    gateway.stepUp({ method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } });
    await gateway.feed.kill();
    gateway.stepUp({ method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } });
    await gateway.feed.resume();
    expect(gateway.requests).toEqual([
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } },
      { method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } },
    ]);
    expect(gateway.forwarded).toEqual([
      { method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'resume' } },
    ]);
    expect(gateway.requests.filter((r) => r.path === '/api/verse/authority'))
      .toEqual([{ method: 'POST', path: '/api/verse/authority', body: { action: 'stop' } }]);
  });

  it('refuses a request carrying a local Hub credential on any route', async () => {
    const gateway = recordingGateway({ localToken: 'a'.repeat(64) });
    await expect(gateway.feed.runs()).rejects.toMatchObject({
      status: 403, code: 'REMOTE_ENVELOPE_DENIED', detail: 'hub-token',
    });
    await expect(gateway.feed.pause()).rejects.toMatchObject({
      status: 403, code: 'REMOTE_ENVELOPE_DENIED', detail: 'hub-token',
    });
    expect(gateway.requests).toEqual([
      { method: 'GET', path: '/api/verse/fleet/runs' },
      { method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } },
    ]);
    expect(gateway.forwarded).toEqual([]);
  });

  it('denies reads and writes once the paired device is revoked', async () => {
    const gateway = recordingGateway();
    expect(await gateway.feed.bus()).toEqual(bus);
    gateway.revoke();
    await expect(gateway.feed.bus()).rejects.toMatchObject({ status: 401, code: 'DEVICE_SESSION_REQUIRED' });
    gateway.stepUp({ method: 'POST', path: '/api/verse/daemon', body: { action: 'pause' } });
    await expect(gateway.feed.pause()).rejects.toMatchObject({ status: 401, code: 'DEVICE_SESSION_REQUIRED' });
    expect(gateway.forwarded).toEqual([{ method: 'GET', path: '/api/verse/fleet/live/bus' }]);
  });
});
