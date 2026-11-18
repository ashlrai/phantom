import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetRuntimeIdentityApi, VERSE_FLEET_RUNTIME_IDENTITY_PATH } from '../src/core/verse/fleet-runtime-identity-api.js';

vi.mock('../src/core/fleet/node-reach-view.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/node-reach-view.js')>(),
  readNodeReachSources: () => ({}),
}));

const home = '/fake/private-home';
const observed = new Date('2026-11-13T18:00:00.000Z');
const generated = new Date('2026-11-13T18:00:05.000Z');

function readers(overrides: Partial<RuntimeIdentityDeps> = {}): RuntimeIdentityDeps {
  return {
    hostname: () => `${home}/host-10.1.2.3`, platform: () => 'fakeos',
    now: () => observed, homeDir: () => home,
    statePath: () => `${home}/guardian/state.json`,
    statMtimeMs: () => observed.getTime() - 901_000,
    readSourcePackageJson: () => '{"version":"1.0.0"}',
    installedVersion: () => '1.0.0',
    exec: () => '{"Self":{"HostName":"fake-node"}}',
    ...overrides,
  };
}

async function request(api: ApiModule, method = 'GET') {
  let status = 0;
  let text = '';
  const response = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, response, VERSE_FLEET_RUNTIME_IDENTITY_PATH, method);
  return { handled, status, text, body: JSON.parse(text) };
}

describe('runtime identity API source clock', () => {
  it('keeps response generation separate from stale evidence observation and sanitizes output', async () => {
    const stat = vi.fn(() => observed.getTime() - 901_000);
    const exec = vi.fn(() => '{"Self":{"HostName":"fake-node"}}');
    const result = await request(createFleetRuntimeIdentityApi({ identityDeps: readers({ statMtimeMs: stat, exec }), now: () => generated }));
    expect(result).toMatchObject({ handled: true, status: 200, body: { v: 1, generatedAt: generated.toISOString(), identity: {
      asOf: observed.toISOString(), host: '~/host-[ip]', fleetState: { path: '~/guardian/state.json', mtime: '2026-11-13T17:44:59.000Z', ageSeconds: 901, stale: true }, reasons: [],
    } } });
    expect(result.text).not.toContain(home);
    expect(result.text).not.toContain('10.1.2.3');
    expect(stat).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledExactlyOnceWith('tailscale', ['status', '--json']);
  });

  it.each(['missing', 'unreadable'])('reports %s state as unknown and rereads after recovery', async (failure) => {
    const stat = vi.fn().mockImplementationOnce(() => { throw new Error(`${failure} private detail`); }).mockReturnValue(observed.getTime() - 20_000);
    const api = createFleetRuntimeIdentityApi({ identityDeps: readers({ statMtimeMs: stat }), now: () => generated });
    const first = await request(api);
    expect(first.body.identity.fleetState).toMatchObject({ mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' });
    expect(first.body.identity.reasons).toContain('fleetState: state file missing or unreadable');
    expect(first.text).not.toContain('private detail');
    const second = await request(api);
    expect(second.body.identity.fleetState).toMatchObject({ mtime: '2026-11-13T17:59:40.000Z', ageSeconds: 20, stale: false });
    expect(second.body.identity.reasons).toEqual([]);
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('returns the documented unknown envelope on an uncaught reader exception and refuses writes', async () => {
    const clock = vi.fn((): Date => { throw new Error('private thrown text'); });
    const api = createFleetRuntimeIdentityApi({ identityDeps: readers({ now: clock }), now: () => generated });
    const result = await request(api);
    expect(result.body).toEqual({ v: 1, generatedAt: generated.toISOString(), nodes: [], identity: {
      host: 'unknown', platform: 'unknown', asOf: generated.toISOString(), installedVersion: 'unknown', sourceVersion: 'unknown', versionDrift: false,
      fleetState: { path: 'unknown', mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' }, tailnetName: 'unknown',
      reasons: ['runtime identity: reader failed; all fields unknown'],
    } });
    expect(result.text).not.toContain('private thrown text');
    const post = await request(api, 'POST');
    expect(post).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(clock).toHaveBeenCalledOnce();
  });
});
