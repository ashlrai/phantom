/**
 * RQ-PHX-RECUTDESKS0C206 — dispatcher-level coverage of /api/ui-settings that
 * the earlier recuts did not pin, through the real `handleApi` entry point:
 *
 *   - the read/write asymmetry of the dispatch gate: with --allow-dispatch
 *     off, GET still answers 200 while PUT is hidden as 404 (an observer can
 *     always read the file; only a dispatch-enabled server may write it)
 *   - the route's own 16 KiB body cap: a just-under PUT is written and a
 *     just-over PUT is a 400, through the dispatcher (not the bare handler)
 *   - a corrupt ~/.ashlr/ui.json is reported over HTTP as parsed:false with
 *     defaults, so an agent sees the signal instead of guessing
 *   - a patch whose group is the wrong TYPE merges around the bad group and
 *     keeps the file's existing values for the rest
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { defaultUiSettings, readUiSettings, uiSettingsPath, writeUiSettings } from '../src/core/ui-settings.js';
import { handleApi } from '../src/core/web/api.js';

let home: string;
let realHome: string | undefined;
let server: Server | undefined;

beforeEach(() => {
  realHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'ui-settings-c206-'));
  process.env['HOME'] = home;
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  rmSync(home, { recursive: true, force: true });
});

const start = async (allowDispatch: boolean) => {
  server = createServer((req, res) => {
    void handleApi(req, res, {} as AshlrConfig, { token: 'tok', allowDispatch });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};

const put = (url: string, body: unknown) =>
  fetch(`${url}/api/ui-settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
    body: JSON.stringify(body),
  });

describe('/api/ui-settings dispatch asymmetry (recut c206)', () => {
  it('reads the file without --allow-dispatch but hides the write route', async () => {
    writeUiSettings({ appearance: { theme: 'dark' } });
    const url = await start(false);

    const get = await fetch(`${url}/api/ui-settings`);
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.exists).toBe(true);
    expect(body.settings.appearance.theme).toBe('dark');

    const denied = await put(url, { appearance: { theme: 'light' } });
    expect(denied.status).toBe(404);
    expect(readUiSettings().settings.appearance.theme).toBe('dark');
  });
});

describe('/api/ui-settings 16 KiB body cap through handleApi (recut c206)', () => {
  it('writes a just-under-cap PUT and rejects a just-over-cap PUT', async () => {
    const url = await start(true);
    // ~15 KiB of legitimate document: an unknown key long enough to exercise
    // the cap without tripping it (unknown keys are dropped and reported).
    const under = await put(url, {
      appearance: { theme: 'dark' },
      notes: 'x'.repeat(14 * 1024),
    });
    expect(under.status).toBe(200);
    const written = await under.json();
    expect(written.settings.appearance.theme).toBe('dark');
    expect(written.problems).toEqual(['unknown group "notes"']);
    expect(JSON.parse(readFileSync(uiSettingsPath(), 'utf8')).appearance.theme).toBe('dark');

    const over = await fetch(`${url}/api/ui-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
      body: `{"appearance":{"theme":"light"},"pad":"${'y'.repeat(17 * 1024)}"}`,
    });
    expect(over.status).toBe(400);
    expect(readUiSettings().settings.appearance.theme).toBe('dark');
  });
});

describe('/api/ui-settings agent-facing edge cases (recut c206)', () => {
  it('reports a corrupt file as parsed:false with defaults, over HTTP', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(uiSettingsPath(), '{ this is not json');
    const url = await start(false);

    const res = await fetch(`${url}/api/ui-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ exists: true, parsed: false });
    expect(body.settings).toEqual(defaultUiSettings());
    expect(body.problems).toEqual(['file is not valid JSON']);
  });

  it('a wrong-typed group in a PUT is dropped but the rest of the patch lands', async () => {
    writeUiSettings({ appearance: { theme: 'dark', density: 'compact' } });
    const url = await start(true);

    const res = await put(url, { appearance: 'neon', layout: { railExpanded: true } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems).toEqual(['"appearance" must be an object']);
    // The bad group kept the file's values; the good group merged in.
    expect(body.settings.appearance).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(body.settings.layout.railExpanded).toBe(true);

    const onDisk = JSON.parse(readFileSync(uiSettingsPath(), 'utf8'));
    expect(onDisk.appearance).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(onDisk.layout.railExpanded).toBe(true);
  });
});
