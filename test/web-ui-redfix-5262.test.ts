/**
 * RQ-PHX-REDDESKFIXCL209 — regression for the redfix that landed PR #5262
 * (bridge: RQ-PHX-RECUTDESKS0C205). The PR's only failing check was Quick
 * typecheck's Tier-1 closure shard: mounting /api/ui-settings inside
 * src/core/web/api.ts pulled src/core/web/ui-settings-api.ts,
 * src/core/ui-settings.ts and src/core/ui-settings-schema.ts into the
 * authority import closure, and the snapshot had not been regenerated. These
 * tests pin the fix: the snapshot covers the new chain, the import that
 * caused the growth is a real runtime import, and the mounted route still
 * answers through the real handleApi dispatcher.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';
import { UI_SETTINGS_PATH } from '../src/core/web/ui-settings-api.js';
import { uiSettingsPath } from '../src/core/ui-settings.js';

const SNAPSHOT_PATH = join(import.meta.dirname, 'fixtures', 'authority', 'tier1-closure.json');
const CLOSURE_FILES = [
  'src/core/web/ui-settings-api.ts',
  'src/core/ui-settings.ts',
  'src/core/ui-settings-schema.ts',
] as const;

describe('Tier-1 closure snapshot after the ui-settings mount', () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as { roots: string[]; closure: string[] };

  it('covers every file the /api/ui-settings mount pulled into the closure', () => {
    for (const file of CLOSURE_FILES) {
      expect(snapshot.closure, `${file} missing from regenerated snapshot`).toContain(file);
    }
  });

  it('the growth enters through a runtime import in api.ts, not a type-only one', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'web', 'api.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*handleUiSettingsApi[^}]*\}\s*from\s*'\.\/ui-settings-api\.js'/);
    expect(source).not.toMatch(/import\s+type[^;]*ui-settings-api/);
  });

  it('snapshot entries stay sorted and unique so the drift check stays deterministic', () => {
    const sorted = [...snapshot.closure].sort();
    expect(snapshot.closure).toEqual(sorted);
    expect(new Set(snapshot.closure).size).toBe(snapshot.closure.length);
  });
});

describe('/api/ui-settings through the real dispatcher', () => {
  let home: string;
  let realHome: string | undefined;
  let server: Server | undefined;

  beforeEach(() => {
    realHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'webui-redfix-5262-'));
    process.env['HOME'] = home;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  const start = async () => {
    server = createServer((req, res) => {
      void handleApi(req, res, {} as AshlrConfig, { token: 'tok', allowDispatch: true });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  it('GET answers the file-backed document and reports the path without leaking HOME', async () => {
    const base = await start();
    const res = await fetch(`${base}${UI_SETTINGS_PATH}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; exists: boolean; settings: { appearance: Record<string, unknown>; layout: Record<string, unknown> } };
    expect(body.path).toBe('~/.ashlr/ui.json');
    expect(body.path).not.toBe(uiSettingsPath());
    expect(body.exists).toBe(false);
    expect(body.settings.appearance['theme']).toBe('system');
    expect(body.settings.layout['sidebarWidth']).toBe(264);
  });

  it('PUT writes the normalized document and a following GET serves it', async () => {
    const base = await start();
    const put = await fetch(`${base}${UI_SETTINGS_PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-ashlr-token': 'tok' },
      body: JSON.stringify({ appearance: { theme: 'dark' }, layout: { sidebarWidth: 300 } }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${base}${UI_SETTINGS_PATH}`);
    const body = await get.json() as { exists: boolean; settings: { appearance: Record<string, unknown>; layout: Record<string, unknown> } };
    expect(body.exists).toBe(true);
    expect(body.settings.appearance['theme']).toBe('dark');
    expect(body.settings.layout['sidebarWidth']).toBe(300);
  });
});
