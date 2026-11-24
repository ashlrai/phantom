/** Settings ▸ Live build limits: saved limits, env override, the alert reading them, and the route that saves them. */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigReadOnlyStrict } from '../src/core/config.js';
import { buildStaleness, resolveBuildStaleLimits, savedBuildStaleLimits } from '../src/core/fleet/build-stale.js';
import { buildPulseAlerts, readPulseAlertInputs } from '../src/core/fleet/pulse-alerts.js';
import { handleVerseControlApi } from '../src/core/verse/control-api.js';
import { saveConfig } from '../src/core/config.js';
const PATH = '/api/verse/build-stale-limits';
const TOKEN = 'tok-build-limits';
let home: string;
const prev: Record<string, string | undefined> = {};
const KEYS = ['HOME', 'USERPROFILE', 'ASHLR_HOME', 'ASHLR_BUILD_STALE_COMMITS', 'ASHLR_BUILD_STALE_HOURS'];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'build-limits-'));
  for (const k of KEYS) { prev[k] = process.env[k]; delete process.env[k]; }
  process.env['HOME'] = home; process.env['USERPROFILE'] = home; process.env['ASHLR_HOME'] = join(home, '.ashlr');
});
afterEach(() => {
  for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  rmSync(home, { recursive: true, force: true });
});
async function call(method: 'GET' | 'POST', body?: unknown, token = TOKEN): Promise<{ status: number; json: any }> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method, url: PATH, headers: { 'x-ashlr-token': token, 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  const out = { status: 0, text: '' };
  const res = {
    writeHead(status: number) { out.status = status; return this; },
    setHeader() { return this; },
    end(chunk?: string) { out.text += chunk ?? ''; },
  } as unknown as ServerResponse;
  const cfg = {}; 
  expect(await handleVerseControlApi({ cfg, token: TOKEN, allowDispatch: true }, req, res, PATH, method)).toBe(true);
  return { status: out.status, json: out.text ? JSON.parse(out.text) : null };
}
describe('saved and resolved limits', () => {
  it('reads only whole in-range numbers; everything else is unset', () => {
    expect(savedBuildStaleLimits({ commits: 80, hours: 12 })).toEqual({ commits: 80, hours: 12 });
    expect(savedBuildStaleLimits({ commits: 0, hours: 1.5 })).toEqual({ commits: null, hours: null });
    expect(savedBuildStaleLimits({ commits: '80', hours: 99_999 })).toEqual({ commits: null, hours: null });
    expect(savedBuildStaleLimits(undefined)).toEqual({ commits: null, hours: null });
  });
  it('env beats saved beats default, per limit', () => {
    const none = { commits: null, hours: null };
    expect(resolveBuildStaleLimits(none, {})).toMatchObject({ commits: 50, hours: 24 });
    expect(resolveBuildStaleLimits({ commits: 80, hours: null }, {})).toMatchObject({ commits: 80, hours: 24 });
    expect(resolveBuildStaleLimits({ commits: 80, hours: 12 }, { ASHLR_BUILD_STALE_COMMITS: '5' }))
      .toEqual({ commits: 5, hours: 12, envOverride: { commits: true, hours: false } });
    expect(resolveBuildStaleLimits({ commits: 80, hours: null }, { ASHLR_BUILD_STALE_COMMITS: 'junk', ASHLR_BUILD_STALE_HOURS: '-3' }))
      .toMatchObject({ commits: 80, hours: 24, envOverride: { commits: false, hours: false } });
  });
});
describe('the alert reads the saved limits', () => {
  it('uses defaults, then the saved value, then the env override', async () => {
    const now = Date.now();
    expect((await readPulseAlertInputs(join(home, 'runs'), now)).buildLimits).toEqual({ commits: 50, hours: 24 });
    saveConfig({ ...loadConfigReadOnlyStrict(), fleet: { buildStale: { commits: 80, hours: 12 } } });
    expect((await readPulseAlertInputs(join(home, 'runs'), now)).buildLimits).toEqual({ commits: 80, hours: 12 });
    process.env['ASHLR_BUILD_STALE_HOURS'] = '6';
    expect((await readPulseAlertInputs(join(home, 'runs'), now)).buildLimits).toEqual({ commits: 80, hours: 6 });
  });
});
describe(`GET/POST ${PATH}`, () => {
  it('reports the defaults when nothing is saved', async () => {
    const r = await call('GET');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ schema: 'ashlr.build-stale-limits.v1', limits: { commits: 50, hours: 24 },
      saved: { commits: null, hours: null }, defaults: { commits: 50, hours: 24 }, envOverride: { commits: false, hours: false } });
  });
  it('saves, reads back, keeps sibling fleet config, and resets with nulls', async () => {
    saveConfig({ ...loadConfigReadOnlyStrict(), fleet: { sharedQueue: { mode: 'off' } } });
    const saved = await call('POST', { commits: 120, hours: 48 });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ limits: { commits: 120, hours: 48 }, saved: { commits: 120, hours: 48 } });
    expect(loadConfigReadOnlyStrict().fleet).toMatchObject({ buildStale: { commits: 120, hours: 48 }, sharedQueue: { mode: 'off' } });
    const partial = await call('POST', { commits: null, hours: 36 });
    expect(partial.json).toMatchObject({ limits: { commits: 50, hours: 36 }, saved: { commits: null, hours: 36 } });
    const reset = await call('POST', { commits: null, hours: null });
    expect(reset.json.saved).toEqual({ commits: null, hours: null });
    expect(loadConfigReadOnlyStrict().fleet?.buildStale).toBeUndefined();
    expect(loadConfigReadOnlyStrict().fleet).toMatchObject({ sharedQueue: { mode: 'off' } });
  });
  it('refuses bad bodies and a wrong token without changing anything', async () => {
    for (const body of [{}, { commits: 5 }, { commits: 0, hours: 24 }, { commits: 1.5, hours: 24 }, { commits: 50, hours: 9_000 },
      { commits: '50', hours: 24 }, { commits: 50, hours: 24, extra: 1 }]) {
      expect((await call('POST', body)).status).toBe(400);
    }
    expect((await call('POST', { commits: 60, hours: 24 }, 'wrong')).status).toBe(401);
    expect(loadConfigReadOnlyStrict().fleet?.buildStale).toBeUndefined();
  });
  it('refuses an unreadable configuration without writing', async () => {
    await call('POST', { commits: 60, hours: 24 });
    const path = join(home, '.ashlr', 'config.json');
    writeFileSync(path, '{broken');
    expect((await call('POST', { commits: 80, hours: 12 })).status).toBe(503);
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
  it('applies the route save to the alert and display, then restores both', async () => {
    const now = Date.now();
    const build = { commit: { state: 'known', sha: 'abc1234', source: 'git' }, behind: { state: 'known', count: 60, ref: 'origin/master', since: null } } as const;
    for (const [commits, expected] of [[100, 'behind'], [null, 'stale']] as const) {
      const response = await call('POST', { commits, hours: null });
      const inputs = await readPulseAlertInputs(join(home, 'runs'), now);
      expect(inputs.buildLimits).toEqual(response.json.limits);
      expect(buildStaleness(build, now, response.json.limits)).toBe(expected);
      expect(buildPulseAlerts({ ...inputs, build }, now).alerts.some(a => a.kind === 'build-stale')).toBe(expected === 'stale');
    }
  });
  it('shows an env override as in force', async () => {
    process.env['ASHLR_BUILD_STALE_COMMITS'] = '7';
    await call('POST', { commits: 60, hours: 24 });
    expect((await call('GET')).json).toMatchObject({ limits: { commits: 7 }, saved: { commits: 60 }, envOverride: { commits: true } });
  });
});
