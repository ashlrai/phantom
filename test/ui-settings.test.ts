/**
 * ~/.ashlr/ui.json: schema coercion, the file round trip (UI write -> agent
 * read, agent hand-edit -> UI read) and the HTTP gates.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultUiSettings,
  normalizeUiSettings,
  readUiSettings,
  uiSettingsPath,
  writeUiSettings,
} from '../src/core/ui-settings.js';
import { handleUiSettingsApi } from '../src/core/web/ui-settings-api.js';

let home: string;
let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'ui-settings-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('normalizeUiSettings', () => {
  it('returns defaults for nothing and flags a non-object document', () => {
    expect(normalizeUiSettings(undefined)).toEqual({ settings: defaultUiSettings(), problems: [] });
    expect(normalizeUiSettings([]).problems).toEqual(['document must be a JSON object']);
  });

  it('clamps numbers, wraps hue, and drops (and reports) unknown or wrong-typed fields', () => {
    const { settings, problems } = normalizeUiSettings({
      appearance: { accentH: -10, accentL: 5, theme: 'neon', density: 'compact', bogus: 1 },
      layout: { sidebarWidth: 9999, resourcesOpen: 'yes', railExpanded: true },
      extra: {},
    });
    expect(settings.appearance).toMatchObject({ accentH: 350, accentL: 30, theme: 'system', density: 'compact' });
    expect(settings.layout).toMatchObject({ sidebarWidth: 360, resourcesOpen: true, railExpanded: true });
    expect(problems.sort()).toEqual([
      'invalid value for "appearance.theme"',
      'invalid value for "layout.resourcesOpen"',
      'unknown group "extra"',
      'unknown setting "appearance.bogus"',
    ]);
  });
});

describe('file round trip', () => {
  it('reads defaults when the file is absent, under the relocated HOME', () => {
    const read = readUiSettings();
    expect(read).toMatchObject({ exists: false, parsed: true, path: join(home, '.ashlr', 'ui.json') });
    expect(read.settings).toEqual(defaultUiSettings());
  });

  it('a UI write is visible to a reader and rewrites the whole file, no temp files left', () => {
    writeUiSettings({ appearance: { theme: 'dark' } });
    writeUiSettings({ layout: { sidebarWidth: 300 } });
    const onDisk = JSON.parse(readFileSync(uiSettingsPath(), 'utf8'));
    expect(onDisk.appearance.theme).toBe('dark'); // second write merged, not replaced
    expect(onDisk.layout.sidebarWidth).toBe(300);
    expect(onDisk.appearance.accentH).toBe(245); // complete document
    expect(readdirSync(join(home, '.ashlr'))).toEqual(['ui.json']);
  });

  it('an agent hand-edit is what the next read returns, with feedback on its mistakes', () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(uiSettingsPath(), JSON.stringify({ layout: { resourcesOpen: false, sidebarWidth: 1 }, nope: 1 }));
    const read = readUiSettings();
    expect(read.settings.layout).toMatchObject({ resourcesOpen: false, sidebarWidth: 240 });
    expect(read.problems).toEqual(['unknown group "nope"']);
  });

  it('survives a corrupt file: defaults on read, replaced by the next valid write', () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(uiSettingsPath(), '{ not json');
    expect(readUiSettings()).toMatchObject({ exists: true, parsed: false, settings: defaultUiSettings() });
    writeUiSettings({ appearance: { density: 'compact' } });
    expect(readUiSettings()).toMatchObject({ parsed: true, settings: { appearance: { density: 'compact' } } });
  });
});

describe('/api/ui-settings', () => {
  let server: Server;
  const start = async (allowDispatch: boolean) => {
    server = createServer((req, res) => {
      void handleUiSettingsApi({ token: 'tok', allowDispatch }, req, res, req.method ?? 'GET');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui-settings`;
  };
  afterEach(() => new Promise<void>((r) => server?.close(() => r())));

  const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('GET returns the file; PUT needs --allow-dispatch, then the token', async () => {
    const ro = await start(false);
    expect((await (await fetch(ro)).json()).exists).toBe(false);
    expect((await put(ro, { appearance: { theme: 'dark' } }, { 'x-ashlr-token': 'tok' })).status).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));

    const rw = await start(true);
    expect((await put(rw, { appearance: { theme: 'dark' } })).status).toBe(401);
    expect((await put(rw, { appearance: { theme: 'dark' } }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect(readUiSettings().exists).toBe(false);

    const ok = await put(rw, { appearance: { theme: 'dark', accentL: 99 }, bogus: {} }, { 'x-ashlr-token': 'tok' });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.settings.appearance).toMatchObject({ theme: 'dark', accentL: 78 });
    expect(body.problems).toEqual(['unknown group "bogus"']);
    expect((await (await fetch(rw)).json()).settings.appearance.theme).toBe('dark');
  });

  it('rejects non-JSON bodies and other methods', async () => {
    const url = await start(true);
    const bad = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-ashlr-token': 'tok' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(405);
  });
});
