/**
 * RQ-PHX-RECUTDESKS0C202 — coverage of the ui-settings recut through the real
 * `handleApi` dispatcher (the route an actual server answers), not just the
 * handler in isolation:
 *
 *   - an agent's hand-edit of ~/.ashlr/ui.json is what GET returns (the file
 *     is re-read on every request; nothing is cached server-side), and the
 *     response redacts the home directory to `~`
 *   - a PUT rewrites the file as the COMPLETE normalized document, so it
 *     doubles as the settings reference an agent can read
 *   - POST is a 405 through the dispatcher and writes nothing
 *   - rapid PUTs converge and leave no tmp files
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  defaultUiSettings,
  UI_SETTINGS_SCHEMA,
  uiSettingsPath,
} from '../src/core/ui-settings.js';
import { handleApi } from '../src/core/web/api.js';

let home: string;
let realHome: string | undefined;
let server: Server;

beforeEach(() => {
  realHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'ui-settings-c202-'));
  process.env['HOME'] = home;
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  rmSync(home, { recursive: true, force: true });
});

const start = async (allowDispatch: boolean) => {
  server = createServer((req, res) => {
    void handleApi(req, res, {} as AshlrConfig, { token: 'tok', allowDispatch });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui-settings`;
};

const put = (url: string, body: unknown) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
    body: JSON.stringify(body),
  });

describe('/api/ui-settings through handleApi (recut c202)', () => {
  it('GET re-reads the file every time: an agent hand-edit shows up verbatim', async () => {
    const url = await start(true);
    const first = await (await fetch(url)).json();
    // sendJson redacts the server's home directory to `~` in every payload:
    // the API reports where the file lives without leaking an absolute path.
    expect(first).toMatchObject({ exists: false, path: '~/.ashlr/ui.json' });

    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(
      uiSettingsPath(),
      JSON.stringify({
        appearance: { theme: 'dark', bogus: 1 },
        layout: { resourcesOpen: false, sidebarWidth: 'wide' },
      }),
    );

    const read = await (await fetch(url)).json();
    expect(read.exists).toBe(true);
    expect(read.settings.appearance.theme).toBe('dark');
    expect(read.settings.layout).toMatchObject({ resourcesOpen: false, sidebarWidth: 264 });
    expect(read.problems.sort()).toEqual([
      'invalid value for "layout.sidebarWidth"',
      'unknown setting "appearance.bogus"',
    ]);
  });

  it('PUT writes the complete normalized document — every schema key present on disk', async () => {
    const url = await start(true);
    const res = await put(url, { appearance: { theme: 'dark' } });
    expect(res.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(uiSettingsPath(), 'utf8'));
    for (const [group, fields] of Object.entries(UI_SETTINGS_SCHEMA)) {
      for (const key of Object.keys(fields)) {
        expect(onDisk[group], `${group}.${key}`).toHaveProperty(key);
      }
    }
    expect(onDisk.appearance.theme).toBe('dark');
    // The group the request never mentioned was still written at defaults.
    expect(onDisk.layout).toEqual(defaultUiSettings().layout);
  });

  it('POST is a 405 and writes nothing', async () => {
    const url = await start(true);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(existsSync(uiSettingsPath())).toBe(false);
  });

  it('a burst of sequential PUTs converges and leaves only ui.json on disk', async () => {
    const url = await start(true);
    for (const [i, width] of [260, 300, 340, 280].entries()) {
      const res = await put(url, { layout: { sidebarWidth: width }, appearance: { accentH: i * 40 } });
      expect(res.status).toBe(200);
    }
    const onDisk = JSON.parse(readFileSync(uiSettingsPath(), 'utf8'));
    expect(onDisk.layout.sidebarWidth).toBe(280);
    expect(onDisk.appearance.accentH).toBe(120);
    expect(readdirSync(join(home, '.ashlr'))).toEqual(['ui.json']);
  });
});
