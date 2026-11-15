import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetRuntimeDeps, RuntimeSnapshot } from '../src/core/fleet/runtime-snapshot.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  createFleetRuntimeSnapshotApi,
  VERSE_FLEET_RUNTIME_SNAPSHOT_PATH as PATH,
  type FleetRuntimeSnapshotResponse,
} from '../src/core/verse/fleet-runtime-snapshot-api.js';

// No host state is read: model an unavailable fleet-state directory.
vi.mock('../src/core/fleet/runs-dir-state.js', () => ({
  readFleetRunsDirState: async () => ({ runsDirPresent: false }),
}));

const NOW = new Date('2026-11-14T18:00:00.000Z');
const DEADLINE_REASON = 'runtime snapshot: read deadline exceeded; all fields unknown';
const FAILED_REASON = 'runtime snapshot: reader failed; all fields unknown';

const FAKE_SNAPSHOT: RuntimeSnapshot = {
  host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '1.2.3',
  pid: 123, uptimeSeconds: 60, platform: 'fake-os', arch: 'fake-arch',
  stateRoot: '~/state',
  lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
  coordination: { state: 'known', activeClaims: 2, newestReturnAgeSeconds: 'UNKNOWN' },
  asOf: NOW.toISOString(), reasons: [],
};

function fakeDeps(over: Partial<FleetRuntimeDeps> = {}): FleetRuntimeDeps {
  return {
    now: () => NOW.getTime(), home: () => '/fake-home', stateRoot: () => '/fake-home/state',
    host: () => 'fake-host', tailnet: () => 'fake-tailnet',
    installedVersion: () => '1.2.3', sourceVersion: () => '1.2.4',
    pid: () => 123, uptime: () => 60, platform: () => 'fake-os', arch: () => 'fake-arch',
    board: () => ({
      schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [],
      claims: [1, 2].map(id => ({
        id: `claim-${id}`, repo: 'fake/repo', task: 'fake task', agent: `fake-agent-${id}`,
        claimedAt: NOW.getTime() - 1000, expiresAt: NOW.getTime() + 1000,
      })),
    }),
    ...over,
  };
}

function capture() {
  const state = { status: 0, text: '', ends: 0 };
  const res = {
    writeHead(code: number) { state.status = code; return this; },
    end(body: string) { state.ends += 1; state.text = body; },
  } as unknown as ServerResponse;
  return { res, state };
}

async function call(api: ApiModule, method = 'GET', path = PATH) {
  const { res, state } = capture();
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, ...state, body: state.text ? JSON.parse(state.text) as FleetRuntimeSnapshotResponse : null };
}

function reasonsOf(body: FleetRuntimeSnapshotResponse | null): string[] {
  return (body?.snapshot as { reasons?: string[] } | undefined)?.reasons ?? [];
}

afterEach(() => { vi.useRealTimers(); });

describe('fleet runtime snapshot HTTP read deadline', () => {
  it('serves the real snapshot within the deadline', async () => {
    const result = await call(createFleetRuntimeSnapshotApi({ runtimeDeps: fakeDeps(), now: () => NOW }));
    expect(result).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(result.body).toMatchObject({ v: 1, authority: 'none', generatedAt: NOW.toISOString() });
    expect(result.body?.snapshot).toMatchObject({ host: 'fake-host', pid: 123, uptimeSeconds: 60 });
  });

  it('maps a rejected read to the fixed UNKNOWN reason without raw error text', async () => {
    const api = createFleetRuntimeSnapshotApi({
      readSnapshot: async () => { throw new Error('private failure /fake-home SECRET=value'); },
      now: () => NOW,
    });
    const result = await call(api);
    expect(result).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(result.body).toMatchObject({ v: 1, authority: 'none' });
    expect(result.body?.snapshot).toMatchObject({ host: 'UNKNOWN', pid: 'UNKNOWN', asOf: 'UNKNOWN' });
    expect(reasonsOf(result.body)).toEqual([FAILED_REASON]);
    for (const privateText of ['private failure', '/fake-home', 'SECRET=value']) {
      expect(result.text).not.toContain(privateText);
    }
  });

  it('answers UNKNOWN at the deadline when the read never settles, once', async () => {
    vi.useFakeTimers();
    let settle!: (snapshot: RuntimeSnapshot) => void;
    const late = new Promise<RuntimeSnapshot>(resolve => { settle = resolve; });
    const readSnapshot = vi.fn(() => late);
    const api = createFleetRuntimeSnapshotApi({ readSnapshot, readDeadlineMs: 1_000, now: () => NOW });
    const { res, state } = capture();
    const pending = api({} as VerseApiContext, {} as IncomingMessage, res, PATH, 'GET');

    await vi.advanceTimersByTimeAsync(999);
    expect(state.ends).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);

    expect(state).toMatchObject({ status: 200, ends: 1 });
    const body = JSON.parse(state.text) as FleetRuntimeSnapshotResponse;
    expect(body).toMatchObject({ v: 1, authority: 'none', generatedAt: NOW.toISOString() });
    expect(body.snapshot).toMatchObject({ host: 'UNKNOWN', pid: 'UNKNOWN', asOf: 'UNKNOWN' });
    expect(reasonsOf(body)).toEqual([DEADLINE_REASON]);
    expect(vi.getTimerCount()).toBe(0);

    // A late resolution must not write a second response.
    settle(FAKE_SNAPSHOT);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(state.ends).toBe(1);
    expect(state.text).toContain(DEADLINE_REASON);
  });

  it('consumes a late rejection after the deadline without a second write', async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const late = new Promise<RuntimeSnapshot>((_resolve, reject) => { fail = reject; });
    const api = createFleetRuntimeSnapshotApi({
      readSnapshot: () => late, readDeadlineMs: 100, now: () => NOW,
    });
    const { res, state } = capture();
    const pending = api({} as VerseApiContext, {} as IncomingMessage, res, PATH, 'GET');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(state.ends).toBe(1);
    expect(reasonsOf(JSON.parse(state.text) as FleetRuntimeSnapshotResponse)).toEqual([DEADLINE_REASON]);
    expect(vi.getTimerCount()).toBe(0);

    fail(new Error('late private failure'));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.ends).toBe(1);
    expect(state.text).not.toContain('late private failure');
  });

  it('serves a successful snapshot on a later call after a timeout', async () => {
    vi.useFakeTimers();
    const readSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise<RuntimeSnapshot>(() => {}))
      .mockResolvedValue(FAKE_SNAPSHOT);
    const api = createFleetRuntimeSnapshotApi({ readSnapshot, readDeadlineMs: 100, now: () => NOW });

    const first = capture();
    const pending = api({} as VerseApiContext, {} as IncomingMessage, first.res, PATH, 'GET');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(reasonsOf(JSON.parse(first.state.text) as FleetRuntimeSnapshotResponse)).toEqual([DEADLINE_REASON]);

    const second = await call(api);
    expect(second).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(second.body?.snapshot).toEqual(FAKE_SNAPSHOT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps GET-only routing and the response envelope', async () => {
    const readSnapshot = vi.fn(async () => FAKE_SNAPSHOT);
    const api = createFleetRuntimeSnapshotApi({ readSnapshot, now: () => NOW });
    const post = await call(api, 'POST');
    expect(post).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect((await call(api, 'GET', '/unrelated')).handled).toBe(false);
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});
