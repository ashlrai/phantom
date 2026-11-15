/** GET /api/verse/fleet/runtime-identity/surface-owner — sanitized surface ownership evidence. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { SURFACES, type SurfaceOwnerReport } from '../src/core/fleet/surface-owner.js';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';
import {
  createFleetRuntimeIdentityApi,
  VERSE_FLEET_RUNTIME_IDENTITY_PATH,
} from '../src/core/verse/fleet-runtime-identity-api.js';
import { VERSE_FLEET_RUNTIME_SNAPSHOT_PATH } from '../src/core/verse/fleet-runtime-snapshot-api.js';
import {
  createFleetSurfaceOwnerApi,
  VERSE_FLEET_SURFACE_OWNER_PATH as PATH,
} from '../src/core/verse/fleet-surface-owner-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const SURFACE_NAMES = [...Object.keys(SURFACES)].sort();

function fakeReport(surface: string): SurfaceOwnerReport {
  return {
    schemaVersion: 1, authority: 'none', surface, asOf: NOW.toISOString(),
    owner: 'agent-fake-1', ownerSource: 'advisory-claim',
    liveClaims: [{ id: 'claim-fake-1', agent: 'agent-fake-1', expiresInSeconds: 60 }],
    lastLanded: { jobId: 'RQ-FAKE-1', pr: 1, date: '2026-11-13T12:00:00.000Z', path: 'docs/FAKE.md' },
    scannedPaths: [...SURFACES[surface]!],
    reasons: [],
  };
}

const identityDeps: RuntimeIdentityDeps = {
  hostname: () => 'fake-host', platform: () => 'fake-os', now: () => NOW,
  homeDir: () => '/fake-home', statePath: () => '/fake-home/state.json',
  statMtimeMs: () => NOW.getTime() - 1000,
  readSourcePackageJson: () => '{"version":"1.0.0"}',
  installedVersion: () => '1.0.0',
  exec: () => { throw new Error('no tailnet'); },
};

// `path` arrives already stripped of the query (the router keeps it in req.url).
async function call(api: ApiModule, method = 'GET', path = PATH, url = path) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await api({} as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

function apiWithRead(read: (surface: string) => Promise<SurfaceOwnerReport | null>) {
  return createFleetRuntimeIdentityApi({
    surfaceOwner: createFleetSurfaceOwnerApi({ read, now: () => NOW }),
    identityDeps,
    now: () => NOW,
  });
}

describe('surface-owner HTTP route', () => {
  it('answers a one-claim report for ?surface=dot-handoff', async () => {
    const read = vi.fn(async (surface: string) => fakeReport(surface));
    const r = await call(apiWithRead(read), 'GET', PATH, `${PATH}?surface=dot-handoff`);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toEqual({
      v: 1, authority: 'none', generatedAt: NOW.toISOString(), report: fakeReport('dot-handoff'),
    });
    expect(r.body.report.owner).toBe('agent-fake-1');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('dot-handoff');
  });

  it('answers one entry per known surface when no query is present', async () => {
    const read = vi.fn(async (surface: string) => fakeReport(surface));
    const r = await call(apiWithRead(read));
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body.v).toBe(1);
    expect(r.body.authority).toBe('none');
    expect(r.body.generatedAt).toBe(NOW.toISOString());
    const surfaces = r.body.surfaces as SurfaceOwnerReport[];
    expect(surfaces.map(entry => entry.surface)).toEqual(SURFACE_NAMES);
    expect(read).toHaveBeenCalledTimes(SURFACE_NAMES.length);
  });

  it.each([
    `${PATH}?surface=nope`,
    `${PATH}?surface=`,
    `${PATH}?root=/tmp`,
    `${PATH}?surface=dot-handoff&root=/tmp`,
    `${PATH}?surface=a&surface=b`,
  ])('rejects %s with 400 before any read', async url => {
    const read = vi.fn(async (surface: string) => fakeReport(surface));
    const r = await call(apiWithRead(read), 'GET', PATH, url);
    expect(r).toMatchObject({ handled: true, status: 400 });
    expect(r.body).toEqual({
      v: 1, authority: 'none', error: 'unknown surface', surfaces: SURFACE_NAMES,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects POST with 405 before any read', async () => {
    const read = vi.fn(async (surface: string) => fakeReport(surface));
    const r = await call(apiWithRead(read), 'POST', PATH, `${PATH}?surface=dot-handoff`);
    expect(r).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('degrades a throwing reader to UNKNOWN without leaking the message', async () => {
    const read = vi.fn(async () => { throw new Error('/Users/someone/secret'); });
    const r = await call(apiWithRead(read), 'GET', PATH, `${PATH}?surface=dot-handoff`);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body.report).toEqual({
      surface: 'dot-handoff', owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [],
      lastLanded: null, scannedPaths: [], reasons: ['surface owner: reader failed'],
      schemaVersion: 1, authority: 'none', asOf: NOW.toISOString(),
    });
    expect(r.text).not.toContain('/Users/');
  });

  it('degrades only the failing surface in the no-query listing', async () => {
    const read = vi.fn(async (surface: string) =>
      surface === 'coordination' ? Promise.reject(new Error('/Users/someone/secret')) : fakeReport(surface));
    const r = await call(apiWithRead(read));
    expect(r.status).toBe(200);
    const surfaces = r.body.surfaces as SurfaceOwnerReport[];
    const degraded = surfaces.find(entry => entry.surface === 'coordination')!;
    expect(degraded.owner).toBe('UNKNOWN');
    expect(degraded.reasons).toEqual(['surface owner: reader failed']);
    expect(surfaces.filter(entry => entry.owner === 'agent-fake-1')).toHaveLength(SURFACE_NAMES.length - 1);
    expect(r.text).not.toContain('/Users/');
  });

  it('keeps identity and snapshot on their existing handlers', async () => {
    const snapshot = vi.fn<ApiModule>(async () => true);
    const surfaceOwner = vi.fn<ApiModule>(createFleetSurfaceOwnerApi({ now: () => NOW }));
    const hostReach = vi.fn<ApiModule>(async () => false);
    const api = createFleetRuntimeIdentityApi({ snapshot, surfaceOwner, hostReach, identityDeps, now: () => NOW });

    const identity = await call(api, 'GET', VERSE_FLEET_RUNTIME_IDENTITY_PATH);
    expect(identity.handled).toBe(true);
    expect(identity.status).toBe(200);
    expect(identity.body.identity.host).toBe('fake-host');
    expect(snapshot).not.toHaveBeenCalled();
    expect(surfaceOwner).not.toHaveBeenCalled();
    expect(hostReach).not.toHaveBeenCalled();

    expect((await call(api, 'GET', VERSE_FLEET_RUNTIME_SNAPSHOT_PATH)).handled).toBe(true);
    expect(snapshot.mock.calls[0]!.slice(3)).toEqual([VERSE_FLEET_RUNTIME_SNAPSHOT_PATH, 'GET']);
    expect(surfaceOwner).not.toHaveBeenCalled();
    expect(hostReach).not.toHaveBeenCalled();

    expect((await call(api, 'GET', PATH, `${PATH}?surface=dot-handoff`)).handled).toBe(true);
    expect(surfaceOwner.mock.calls[0]!.slice(3)).toEqual([PATH, 'GET']);
  });
});
