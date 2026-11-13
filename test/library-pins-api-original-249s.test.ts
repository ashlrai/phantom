/**
 * RQ-PHX-LIBRARYPINSAPIRECOVER249S — Library pins HTTP API, recovered from
 * open PR #4366 (RQ-PHX-LIBRARYPINS13, head 13b0eebc3ee92586a1418d3b66e4a2747bc6a459).
 *
 * The store (src/core/fleet/library-pins.ts) and the CLI
 * (`ashlr fleet library-pins`) already landed; only the Verse HTTP slice was
 * missing. This suite exercises the REAL mounted Verse API — the real server,
 * the real handleVerseApi dispatch and the real non-GET mutation gate — with
 * an isolated temporary HOME, so ~/.phantom/library-pins.json is the only
 * store touched.
 *
 * The module is registered through setMountedApiModulesForTest because the
 * DEFAULT_API_MODULES entry is owner-lane: test/verse-api-mount-310.test.ts
 * pins the exact module-id list and the mount grows the Tier-1 closure
 * snapshot (both protected paths). BRIDGE_NOTES.md carries the landing steps.
 * Every case below keeps passing once the default registration lands, because
 * the hook only swaps which table dispatchMountedModules reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import {
  invalidateVerseSeatCache,
  resetVerseEngine,
  setMountedApiModulesForTest,
  type MountedApiModule,
  type MountedApiModuleId,
} from '../src/core/verse/verse-api.js';
import { handleLibraryPinsApi, VERSE_LIBRARY_PINS_PATH } from '../src/core/verse/library-pins-api.js';
import { listPins } from '../src/core/fleet/library-pins.js';
import { cmdFleetLibraryPins } from '../src/cli/fleet-library-pins.js';
import { startServer, readAuthHeaders } from './helpers/authenticated-web-server.js';

const PINS = VERSE_LIBRARY_PINS_PATH;

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

function emptyEngine(): VerseEngineHandle {
  return {
    listSessions: () => [],
    getSession: () => null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

interface HttpResult { status: number; json: unknown }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];

const LIBRARY_PINS_MODULE: MountedApiModule = {
  id: 'library-pins' as MountedApiModuleId,
  load: async () => handleLibraryPinsApi,
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-library-pins-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const accountsRoot = path.join(tmpHome, '.ashlr', 'account-connections');
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
  cfg = makeConfig(accountsRoot);
  resetVerseEngine(emptyEngine());
  invalidateVerseSeatCache();
  setMountedApiModulesForTest([LIBRARY_PINS_MODULE]);
  handles = [];
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  setMountedApiModulesForTest(null);
  resetVerseEngine(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function boot(opts: { allowDispatch?: boolean } = {}) {
  const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  return {
    port: handle.port,
    read: readAuthHeaders(handle.port),
    mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' },
  };
}

const post = (port: number, mutate: Record<string, string>, body: string) =>
  request(port, 'POST', PINS, mutate, body);

describe('mounted library pins routes', () => {
  it('reads empty, adds, persists and lists the same pin the CLI store holds', async () => {
    const { port, read, mutate } = await boot();
    const empty = await request(port, 'GET', PINS, read);
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ v: 1, pins: [] });

    const added = await post(port, mutate, JSON.stringify({ kind: 'memory', ref: '/work/alpha', title: 'alpha memory' }));
    expect(added.status).toBe(200);
    const body = added.json as { v: number; pin: { id: string; kind: string; ref: string; title: string }; pins: unknown[] };
    expect(body.v).toBe(1);
    expect(body.pin).toMatchObject({ kind: 'memory', ref: '/work/alpha', title: 'alpha memory' });
    expect(body.pin.id).toMatch(/^pin_[a-f0-9]{12}$/);
    expect(body.pins).toHaveLength(1);

    // The durable store on disk is the one the CLI and context pack read.
    const storeFile = path.join(tmpHome, '.phantom', 'library-pins.json');
    expect(fs.existsSync(storeFile)).toBe(true);
    expect(listPins({ home: tmpHome })).toEqual([body.pin]);

    const again = await request(port, 'GET', PINS, read);
    expect(again.json).toEqual({ v: 1, pins: [body.pin] });

    // The CLI reads the identical pin the HTTP route just wrote.
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      expect(await cmdFleetLibraryPins(['list', '--json'], { home: tmpHome })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(logged[0]!)).toEqual({ v: 1, pins: [body.pin] });
  });

  it('dedupes a repeat pin by kind+ref and returns the existing pin', async () => {
    const { port, mutate } = await boot();
    const first = await post(port, mutate, JSON.stringify({ kind: 'note', ref: 'plan', title: 'the plan' }));
    const second = await post(port, mutate, JSON.stringify({ kind: 'note', ref: 'plan', title: 'renamed plan' }));
    expect(second.status).toBe(200);
    const a = (first.json as { pin: { id: string } }).pin;
    const b = (second.json as { pin: { id: string }; pins: unknown[] }).pin;
    expect(b.id).toBe(a.id);
    expect((second.json as { pins: unknown[] }).pins).toHaveLength(1);
    expect(listPins({ home: tmpHome })).toHaveLength(1);
  });

  it('unpins through both POST {remove:id} and DELETE /pins/<id>', async () => {
    const { port, mutate } = await boot();
    const made = await post(port, mutate, JSON.stringify({ kind: 'file', ref: 'docs/PLAN.md', title: 'Plan of record' }));
    const pin = (made.json as { pin: { id: string } }).pin;

    const viaPost = await post(port, mutate, JSON.stringify({ remove: pin.id }));
    expect(viaPost.status).toBe(200);
    expect(viaPost.json).toEqual({ v: 1, removed: true, pins: [] });

    const remade = await post(port, mutate, JSON.stringify({ kind: 'bus', ref: 'm42', title: 'worker note' }));
    const pin2 = (remade.json as { pin: { id: string } }).pin;
    const viaDelete = await request(port, 'DELETE', `${PINS}/${pin2.id}`, { ...mutate, 'content-length': '2' }, '{}');
    expect(viaDelete.json, `DELETE ${PINS}/${pin2.id}`).toEqual({ v: 1, removed: true, pins: [] });
    expect(viaDelete.status).toBe(200);
    expect(listPins({ home: tmpHome })).toEqual([]);

    // Removing an id that is not pinned is a quiet false, not an error.
    const missing = await post(port, mutate, JSON.stringify({ remove: 'pin_000000000000' }));
    expect(missing.json).toMatchObject({ v: 1, removed: false });
  });

  it('refuses malformed payloads, arrays and unknown keys with bounded 400s', async () => {
    const { port, mutate } = await boot();
    const badJson = await post(port, mutate, '{not json');
    expect(badJson.status).toBe(400);
    expect(badJson.json).toMatchObject({ code: 'VERSE_INVALID' });

    const array = await post(port, mutate, '[1,2,3]');
    expect(array.status).toBe(400);
    expect((array.json as { error: string }).error).toMatch(/JSON object/);

    const extra = await post(port, mutate, JSON.stringify({ kind: 'note', ref: 'r', title: 't', body: 'x' }));
    expect(extra.status).toBe(400);
    expect((extra.json as { error: string }).error).toMatch(/unknown key: body/);

    const scalar = await post(port, mutate, JSON.stringify({ remove: 42 }));
    expect(scalar.status).toBe(400);
    expect((scalar.json as { error: string }).error).toMatch(/remove must be a pin id/);

    const badKind = await post(port, mutate, JSON.stringify({ kind: 'secret', ref: 'r', title: 't' }));
    expect(badKind.status).toBe(400);
    expect(listPins({ home: tmpHome })).toEqual([]);
  });

  it('refuses a secret-shaped ref without writing it', async () => {
    const { port, mutate } = await boot();
    const fake = 'sk-' + 'FAKE0000000000000000';
    const res = await post(port, mutate, JSON.stringify({ kind: 'note', ref: fake, title: 'key' }));
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/looks like a secret/);
    expect(listPins({ home: tmpHome })).toEqual([]);
  });

  it('answers 405 for the wrong method and 404 for paths the module does not own', async () => {
    const { port, read, mutate } = await boot();
    const put = await request(port, 'PUT', PINS, mutate, '{}');
    expect(put.status).toBe(405);

    const getItem = await request(port, 'GET', `${PINS}/pin_000000000000`, read);
    expect(getItem.status).toBe(405);

    for (const p of ['/api/verse/library/other', `${PINS}/a/b`]) {
      const res = await request(port, 'GET', p, read);
      expect(res.status).toBe(404);
    }
  });

  it('requires the mutation token and refuses mutations when dispatch is off', async () => {
    const { port } = await boot();
    const noToken = await request(port, 'POST', PINS, { 'content-type': 'application/json' }, '{}');
    expect(noToken.status).toBe(401);

    const off = await boot({ allowDispatch: false });
    const denied = await post(off.port, off.mutate, JSON.stringify({ kind: 'note', ref: 'r', title: 't' }));
    expect(denied.status).toBe(404);
    expect(listPins({ home: tmpHome })).toEqual([]);
  });
});
