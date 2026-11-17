/**
 * Evidence-boundary contract for `ashlr fleet runtime-identity` (RQ-PHX-RUNTIMEPROOFQUALIFY529S).
 *
 * Existing suites cover the core reader, the clock-skew cases and the Slack
 * reply formatter. This file only adds what they do not: through the real CLI
 * handler, the captured --json/text output must (a) keep the observation time
 * separate from state freshness, (b) never carry a claim, shared-context,
 * assignment, dispatch or receipt field, so a state mtime or a successful
 * tailscale call cannot be read as one, and (c) keep IPs/home redacted in every
 * scenario. All hosts, paths and times are synthetic; nothing runs tailscale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntimeIdentity } from '../src/cli/fleet-runtime-identity.js';
import type { RuntimeIdentity, RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const HOME = '/home/fakeuser';
const STATE_PATH = `${HOME}/.ashlr-runs/guardian/state.json`;

function deps(over: Partial<RuntimeIdentityDeps> = {}): RuntimeIdentityDeps {
  return {
    hostname: () => 'fake-reachable-host',
    platform: () => 'fakeos',
    now: () => new Date(NOW),
    homeDir: () => HOME,
    statePath: () => STATE_PATH,
    statMtimeMs: () => NOW - 60_000,
    readSourcePackageJson: () => JSON.stringify({ version: '1.2.3' }),
    installedVersion: () => '1.2.3',
    exec: () => JSON.stringify({ Self: { HostName: 'fake-node', TailscaleIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'] } }),
    ...over,
  };
}

async function runJson(d: RuntimeIdentityDeps): Promise<{ id: RuntimeIdentity; raw: string }> {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  expect(await cmdFleetRuntimeIdentity(['--json'], d)).toBe(0);
  const raw = out.join('\n');
  return { id: JSON.parse(raw) as RuntimeIdentity, raw };
}

async function runText(d: RuntimeIdentityDeps): Promise<string> {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  expect(await cmdFleetRuntimeIdentity([], d)).toBe(0);
  return out.join('\n');
}

/** Keys at any depth of the parsed output. */
function allKeys(value: unknown, acc: string[] = []): string[] {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { acc.push(k); allKeys(v, acc); }
  }
  return acc;
}

const SCENARIOS: Array<[string, Partial<RuntimeIdentityDeps>]> = [
  ['fresh', {}],
  ['stale mtime', { statMtimeMs: () => NOW - 3 * 3600_000 }],
  ['future mtime', { statMtimeMs: () => NOW + 10 * 60_000 }],
  ['missing state', { statMtimeMs: () => { throw new Error('ENOENT'); } }],
  ['tailscale unavailable', { exec: () => { throw new Error('ENOENT'); } }],
  ['version mismatch', { installedVersion: () => '1.0.0' }],
  ['unknown versions', { installedVersion: () => null, readSourcePackageJson: () => '{' }],
];

afterEach(() => vi.restoreAllMocks());

describe('runtime-identity CLI evidence boundary', () => {
  it('keeps asOf (observation time) distinct from fleetState.mtime for a stale state on a reachable host', async () => {
    const { id } = await runJson(deps({ statMtimeMs: () => NOW - 3 * 3600_000 }));
    expect(id.asOf).toBe('2026-11-17T12:00:00.000Z');
    expect(id.fleetState.mtime).toBe('2026-11-17T09:00:00.000Z');
    expect(id.fleetState).toMatchObject({ ageSeconds: 3 * 3600, stale: true });
    // Reaching the host and tailnet does not refresh the state.
    expect(id.tailnetName).toBe('fake-node');
    expect(id.host).toBe('fake-reachable-host');
    expect(id.asOf).not.toBe(id.fleetState.mtime);
  });

  it('a fresh mtime plus a successful tailscale call proves only those two reads, in every output field', async () => {
    const { id, raw } = await runJson(deps());
    expect(id.fleetState).toMatchObject({ ageSeconds: 60, stale: false });
    expect(id.tailnetName).toBe('fake-node');
    expect(id.reasons).toEqual([]);
    expect(Object.keys(id).sort()).toEqual([
      'asOf', 'fleetState', 'host', 'installedVersion', 'platform', 'reasons',
      'sourceVersion', 'tailnetName', 'versionDrift',
    ]);
    expect(Object.keys(id.fleetState).sort()).toEqual(['ageSeconds', 'mtime', 'path', 'stale']);
    // No raw tailscale payload (peer list, IPs) is forwarded.
    expect(raw).not.toContain('TailscaleIPs');
  });

  it.each(SCENARIOS)('never emits a claim, shared-context, assignment, dispatch or receipt field (%s)', async (_name, over) => {
    const { id } = await runJson(deps(over));
    const forbidden = /claim|shared|context|assign|dispatch|receipt|bridge|online|ready|verdict|proof/i;
    expect(allKeys(id).filter(k => forbidden.test(k))).toEqual([]);
    const text = await runText(deps(over));
    expect(text.split('\n').filter(l => /^(claim|shared|context|assign|dispatch|receipt|bridge|online|verdict)/i.test(l))).toEqual([]);
  });

  it('only ever invokes `tailscale status --json`, so a successful call is not a dispatch or claim read', async () => {
    const exec = vi.fn(() => JSON.stringify({ Self: { HostName: 'fake-node' } }));
    await runJson(deps({ exec }));
    await runText(deps({ exec }));
    expect(exec).toHaveBeenCalledTimes(2);
    for (const call of exec.mock.calls) expect(call).toEqual(['tailscale', ['status', '--json']]);
  });

  it('reports missing state as unknown in JSON and text, with the observation time still present', async () => {
    const d = deps({ statMtimeMs: () => { throw new Error('ENOENT'); } });
    const { id } = await runJson(d);
    expect(id.asOf).toBe('2026-11-17T12:00:00.000Z');
    expect(id.fleetState).toMatchObject({ mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' });
    expect(id.fleetState.stale).not.toBe(false);
    expect(id.reasons).toContain('fleetState: state file missing or unreadable');
    const text = await runText(d);
    expect(text).toContain('asOf: 2026-11-17T12:00:00.000Z');
    expect(text).toContain('fleetState.mtime: unknown');
    expect(text).toContain('fleetState.stale: unknown');
    expect(text).not.toContain('fleetState.stale: false');
  });

  it('keeps a future mtime as an observation: mtime shown, freshness unknown, asOf unchanged', async () => {
    const future = NOW + 10 * 60_000;
    const { id } = await runJson(deps({ statMtimeMs: () => future }));
    expect(id.asOf).toBe('2026-11-17T12:00:00.000Z');
    expect(id.fleetState.mtime).toBe(new Date(future).toISOString());
    expect(id.fleetState.ageSeconds).toBe('unknown');
    expect(id.fleetState.stale).toBe('unknown');
    expect(id.reasons.some(r => r.includes('in the future'))).toBe(true);
  });

  it('an unreadable clock makes asOf and freshness unknown without inventing a time', async () => {
    const { id } = await runJson(deps({ now: () => new Date(Number.NaN) }));
    expect(id.asOf).toBe('unknown');
    expect(id.fleetState.mtime).toBe('2026-11-17T11:59:00.000Z');
    expect(id.fleetState).toMatchObject({ ageSeconds: 'unknown', stale: 'unknown' });
  });

  it('unavailable tailscale leaves state freshness untouched and tailnetName unknown', async () => {
    const { id } = await runJson(deps({ exec: () => { throw new Error('ENOENT'); } }));
    expect(id.tailnetName).toBe('unknown');
    expect(id.fleetState).toMatchObject({ ageSeconds: 60, stale: false });
    expect(id.reasons).toEqual(['tailnetName: tailscale unavailable or status unreadable']);
  });

  it('state freshness never depends on tailscale success or version knowledge', async () => {
    const baseline = (await runJson(deps())).id.fleetState;
    for (const over of [
      { exec: () => { throw new Error('x'); } },
      { installedVersion: () => '9.9.9' },
      { installedVersion: () => null },
    ] as Array<Partial<RuntimeIdentityDeps>>) {
      expect((await runJson(deps(over))).id.fleetState).toEqual(baseline);
    }
  });

  it('versionDrift follows known versions only: mismatch true, equal false, any unknown side false', async () => {
    expect((await runJson(deps({ installedVersion: () => '1.0.0' }))).id).toMatchObject({
      installedVersion: '1.0.0', sourceVersion: '1.2.3', versionDrift: true,
    });
    expect((await runJson(deps())).id.versionDrift).toBe(false);

    const noInstalled = (await runJson(deps({ installedVersion: () => null }))).id;
    expect(noInstalled).toMatchObject({ installedVersion: 'unknown', sourceVersion: '1.2.3', versionDrift: false });
    const noSource = (await runJson(deps({ readSourcePackageJson: () => JSON.stringify({}) }))).id;
    expect(noSource).toMatchObject({ installedVersion: '1.2.3', sourceVersion: 'unknown', versionDrift: false });
    const neither = (await runJson(deps({ installedVersion: () => '', readSourcePackageJson: () => 'not json' }))).id;
    expect(neither).toMatchObject({ installedVersion: 'unknown', sourceVersion: 'unknown', versionDrift: false });
    expect(neither.reasons.filter(r => /Version/.test(r))).toHaveLength(2);

    const text = await runText(deps({ installedVersion: () => null }));
    expect(text).toContain('installedVersion: unknown');
    expect(text).toContain('versionDrift: false');
  });

  it.each(SCENARIOS)('redacts home and IPs in JSON and text output even when injected into every field (%s)', async (_name, over) => {
    const leaky = deps({
      hostname: () => `${HOME}-box-10.20.30.40`,
      platform: () => 'fakeos-192.168.1.5',
      installedVersion: () => '1.2.3-fd7a:115c:a1e0::9',
      readSourcePackageJson: () => JSON.stringify({ version: `1.2.3-${HOME}` }),
      exec: () => JSON.stringify({ Self: { HostName: `node-100.64.0.9-${HOME}` } }),
      ...over,
    });
    const { raw } = await runJson(leaky);
    const text = await runText(leaky);
    for (const out of [raw, text]) {
      expect(out).not.toContain(HOME);
      expect(out).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(out).not.toContain('fd7a:115c');
      expect(out).not.toMatch(/\w=\S/);
    }
    expect(text).toContain('fleetState.path: ~/.ashlr-runs/guardian/state.json');
  });
});
