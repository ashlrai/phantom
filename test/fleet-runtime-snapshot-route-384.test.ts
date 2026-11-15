import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
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

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('joined runtime snapshot HTTP route', () => {
  it('serves the desktop envelope with runtime identity and two live claims', async () => {
    const result = await call(createFleetRuntimeSnapshotApi({ runtimeDeps: fakeDeps(), now: () => NOW }));
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    const body: FleetRuntimeSnapshotResponse = result.body;
    expect(body).toEqual({
      v: 1, authority: 'none', generatedAt: NOW.toISOString(),
      snapshot: {
        host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '1.2.3', sourceVersion: '1.2.4',
        pid: 123, uptimeSeconds: 60, platform: 'fake-os', arch: 'fake-arch', stateRoot: '~/state',
        lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
        coordination: { state: 'known', activeClaims: 2, newestReturnAgeSeconds: 'UNKNOWN',
          reason: 'no readable retained return at or before asOf' },
        execution: { state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
          reason: 'execution: ledger unavailable' },
        asOf: NOW.toISOString(), reasons: ['lastFleetStateRead: state missing, unreadable or scan limit exceeded'],
      },
    });
    expect(result.text).not.toContain('/fake-home');
  });

  it('rejects POST before reading runtime state', async () => {
    const read = vi.fn(() => { throw new Error('must not read'); });
    const result = await call(createFleetRuntimeSnapshotApi({ runtimeDeps: fakeDeps({ now: read }) }), 'POST');
    expect(result).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns false for unrelated paths, including snapshot descendants', async () => {
    const read = vi.fn(() => NOW.getTime());
    const api = createFleetRuntimeSnapshotApi({ runtimeDeps: fakeDeps({ now: read }) });
    for (const path of ['/unrelated', `${PATH}/extra`]) {
      expect(await call(api, 'GET', path)).toMatchObject({ handled: false, status: 0, text: '' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('replaces a thrown reader with all UNKNOWN evidence and a fixed reason', async () => {
    const result = await call(createFleetRuntimeSnapshotApi({
      runtimeDeps: fakeDeps({ now: () => { throw new Error('private failure /fake-home 192.0.2.1 SECRET=value'); } }),
      now: () => NOW,
    }));
    expect(result).toMatchObject({ handled: true, status: 200 });
    expect(result.body).toEqual({
      v: 1, authority: 'none', generatedAt: NOW.toISOString(),
      snapshot: {
        host: 'UNKNOWN', tailnetName: 'UNKNOWN', installedVersion: 'UNKNOWN', sourceVersion: 'UNKNOWN',
        pid: 'UNKNOWN', uptimeSeconds: 'UNKNOWN', platform: 'UNKNOWN', arch: 'UNKNOWN', stateRoot: 'UNKNOWN',
        lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
        coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN' },
        asOf: 'UNKNOWN', reasons: ['runtime snapshot: reader failed; all fields unknown'],
      },
    });
    for (const privateText of ['private failure', '/fake-home', '192.0.2.1', 'SECRET=value']) {
      expect(result.text).not.toContain(privateText);
    }
  });

  it('delegates exactly snapshot to its seam and preserves hostReach sub-paths', async () => {
    const snapshot = vi.fn<ApiModule>(async () => true);
    const hostReach = vi.fn<ApiModule>(async () => false);
    const api = createFleetRuntimeIdentityApi({ snapshot, hostReach });
    expect((await call(api)).handled).toBe(true);
    expect(snapshot.mock.calls[0].slice(3)).toEqual([PATH, 'GET']);
    expect(hostReach).not.toHaveBeenCalled();
    for (const suffix of ['tailnet-peers', 'pool-reach', 'snapshot/extra']) {
      const path = `/api/verse/fleet/runtime-identity/${suffix}`;
      expect((await call(api, 'GET', path)).handled).toBe(false);
      expect(hostReach.mock.calls.at(-1)?.slice(3)).toEqual([path, 'GET']);
    }
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
