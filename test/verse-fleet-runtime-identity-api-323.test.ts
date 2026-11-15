/** GET /api/verse/fleet/runtime-identity — the Fleet Host RuntimeIdentityCard feed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_RUNTIME_IDENTITY_PATH as PATH,
  createFleetRuntimeIdentityApi,
} from '../src/core/verse/fleet-runtime-identity-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';
import { narrowRuntimeIdentity } from '../src/web-ui/routes/verse/fleet-host/runtime-identity-model.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const HOME = '/Users/fakehome';

function deps(over: Partial<RuntimeIdentityDeps> = {}): RuntimeIdentityDeps {
  return {
    hostname: () => 'studio',
    platform: () => 'darwin',
    now: () => NOW,
    homeDir: () => HOME,
    statePath: () => `${HOME}/.ashlr/guardian/state.json`,
    statMtimeMs: () => NOW.getTime() - 120_000,
    readSourcePackageJson: () => JSON.stringify({ version: '1.2.3' }),
    installedVersion: () => '1.2.2',
    exec: () => JSON.stringify({ Self: { HostName: 'studio-ts' } }),
    ...over,
  };
}

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet runtime-identity api', () => {
  it('returns the envelope the card narrows', async () => {
    const r = await call(createFleetRuntimeIdentityApi({ identityDeps: deps(), now: () => NOW }));
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.v).toBe(1);
    expect(r.body.generatedAt).toBe(NOW.toISOString());
    const view = narrowRuntimeIdentity(r.body);
    expect(view).toMatchObject({
      host: 'studio', platform: 'darwin', installedVersion: '1.2.2', sourceVersion: '1.2.3',
      versionDrift: true, tailnetName: 'studio-ts', fleetState: { ageSeconds: 120, stale: false }, reasons: [],
    });
  });

  it('never leaks the home dir or an IP address', async () => {
    const r = await call(createFleetRuntimeIdentityApi({
      identityDeps: deps({
        hostname: () => `${HOME}/box-10.1.2.3`,
        exec: () => JSON.stringify({ Self: { HostName: 'node-192.168.0.7-fd7a:115c:a1e0::1' } }),
      }),
      now: () => NOW,
    }));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(HOME);
    expect(r.text).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it('degrades to unknown fields with a reason when the reader throws', async () => {
    const r = await call(createFleetRuntimeIdentityApi({
      identityDeps: deps({ now: () => { throw new Error(`boom ${HOME}`); } }),
      now: () => NOW,
    }));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('boom');
    expect(r.body.identity.host).toBe('unknown');
    expect(r.body.identity.reasons.length).toBeGreaterThan(0);
    expect(narrowRuntimeIdentity(r.body)).toMatchObject({ host: 'unknown', fleetState: { ageSeconds: 'unknown', stale: 'unknown' } });
  });

  it('rejects non-GET with 405 and ignores other paths', async () => {
    const api = createFleetRuntimeIdentityApi({ identityDeps: deps(), now: () => NOW });
    const post = await call(api, 'POST');
    expect(post.handled).toBe(true);
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: 'method not allowed' });
    expect((await call(api, 'GET', '/api/verse/fleet/other')).handled).toBe(false);
  });

  it('is registered exactly once in the workbench route table', () => {
    const rows = WORKBENCH_ROUTE_FAMILIES.filter(f => (f.prefixes as readonly string[]).includes(PATH));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'desktop-command', handler: 'handleFleetRuntimeIdentityApi' });
  });
});
