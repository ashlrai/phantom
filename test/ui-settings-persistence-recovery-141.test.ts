/**
 * ui-settings-persistence-recovery-141.test.ts — bounded regression suite for
 * the recovered GET/PUT /api/ui-settings backend slice (recovered from PR
 * #4974 head f58a85077ac938fea0dbd08f89c15aa188f5f9c8 onto current master).
 *
 * Units under test, all through the REAL handleApi dispatcher:
 *   - GET /api/ui-settings returns normalized settings + problems.
 *   - PUT /api/ui-settings merges a partial patch, persists atomically, and a
 *     second reader observes the same values; untouched fields are preserved.
 *   - Gates: 404 when dispatch is disabled, 401 without/with wrong token,
 *     415 without a JSON content type, 400 on malformed JSON — all leaving the
 *     on-disk bytes unchanged.
 *   - Coercion: out-of-range ints clamp/wrap, invalid enums are dropped and
 *     reported without overwriting good stored values.
 *   - Fail-safe reads: corrupt JSON, oversized and symlinked ui.json report
 *     problems and defaults; a symlink target is never followed or modified.
 *
 * HOME is relocated to a fresh tmp dir per test; only synthetic files are
 * touched — never the operator's real ~/.ashlr/ui.json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleApi } from '../src/core/web/api.js';
import { defaultConfig } from '../src/core/config.js';
import {
  defaultUiSettings,
  MAX_UI_SETTINGS_FILE_BYTES,
  readUiSettings,
  uiSettingsDir,
  uiSettingsPath,
} from '../src/core/ui-settings.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-token-ui-settings';
const PATH = '/api/ui-settings';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-ui-settings-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

interface FakeResponse { statusCode: number; body: string; headers: Record<string, string>; ended: boolean; }

function makeFakeReqRes(opts: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): {
  req: IncomingMessage; res: ServerResponse; captured: FakeResponse;
} {
  const captured: FakeResponse = { statusCode: 200, body: '', headers: {}, ended: false };
  const req = new EventEmitter() as IncomingMessage;
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? PATH;
  req.headers = opts.headers ?? {};
  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body, 'utf8'));
    req.emit('end');
  });
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    setHeader(name: string, value: string) { captured.headers[name] = value; },
    end(data?: string) { if (data) captured.body += data; captured.ended = true; },
    write(chunk: string) { captured.body += chunk; return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

const get = () => makeFakeReqRes({ method: 'GET' });
const put = (body: unknown, headers: Record<string, string> = {}) =>
  makeFakeReqRes({
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TEST_TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const json = (captured: FakeResponse): any => JSON.parse(captured.body);
const dispatch = (req: IncomingMessage, res: ServerResponse, allowDispatch: boolean) =>
  handleApi(req, res, defaultConfig(), { token: TEST_TOKEN, allowDispatch });

const fileBytes = (): string | null => {
  try { return readFileSync(uiSettingsPath(), 'utf8'); } catch { return null; }
};

const seedFile = (contents: string): void => {
  mkdirSync(uiSettingsDir(), { recursive: true });
  writeFileSync(uiSettingsPath(), contents, 'utf8');
};

// ---------------------------------------------------------------------------
// GET /api/ui-settings
// ---------------------------------------------------------------------------

describe('GET /api/ui-settings', () => {
  it('returns normalized defaults when the file is absent', async () => {
    const { req, res, captured } = get();
    expect(await dispatch(req, res, false)).toBe(true);
    expect(captured.statusCode).toBe(200);
    const body = json(captured);
    expect(body.exists).toBe(false);
    expect(body.parsed).toBe(true);
    expect(body.settings).toEqual(defaultUiSettings());
    expect(body.problems).toEqual([]);
  });

  it('reports normalized values after a persisted write', async () => {
    const w = put({ appearance: { theme: 'dark', density: 'compact' }, layout: { sidebarWidth: 300 } });
    await dispatch(w.req, w.res, true);
    expect(w.captured.statusCode).toBe(200);

    const { req, res, captured } = get();
    await dispatch(req, res, false);
    const body = json(captured);
    expect(body.exists).toBe(true);
    expect(body.parsed).toBe(true);
    expect(body.settings.appearance.theme).toBe('dark');
    expect(body.settings.appearance.density).toBe('compact');
    expect(body.settings.layout.sidebarWidth).toBe(300);
    // Untouched fields keep defaults.
    expect(body.settings.appearance.accentH).toBe(245);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/ui-settings — persistence and gates
// ---------------------------------------------------------------------------

describe('PUT /api/ui-settings', () => {
  it('persists a partial patch; a second reader sees the same values and untouched fields survive', async () => {
    const first = put({ appearance: { theme: 'dark' } });
    await dispatch(first.req, first.res, true);
    expect(first.captured.statusCode).toBe(200);
    expect(json(first.captured).settings.appearance.theme).toBe('dark');

    const second = put({ layout: { resourcesOpen: false } });
    await dispatch(second.req, second.res, true);
    expect(second.captured.statusCode).toBe(200);

    // Independent reader (new request, and the store read directly).
    const { req, res, captured } = get();
    await dispatch(req, res, false);
    const body = json(captured);
    expect(body.settings.appearance.theme).toBe('dark');
    expect(body.settings.layout.resourcesOpen).toBe(false);
    expect(readUiSettings().settings.appearance.theme).toBe('dark');

    // On-disk document is complete and normalized.
    const onDisk = JSON.parse(fileBytes()!);
    expect(onDisk.appearance.theme).toBe('dark');
    expect(onDisk.layout.resourcesOpen).toBe(false);
    expect(onDisk.appearance.accentL).toBe(58);
  });

  it('is a 404 when dispatch is disabled and leaves no file', async () => {
    const { req, res, captured } = put({ appearance: { theme: 'dark' } });
    await dispatch(req, res, false);
    expect(captured.statusCode).toBe(404);
    expect(fileBytes()).toBeNull();
  });

  it('is a 401 without the token or with a wrong token; bytes unchanged', async () => {
    seedFile(JSON.stringify({ appearance: { theme: 'light' } }));
    const before = fileBytes();

    const noToken = makeFakeReqRes({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appearance: { theme: 'dark' } }),
    });
    await dispatch(noToken.req, noToken.res, true);
    expect(noToken.captured.statusCode).toBe(401);

    const wrongToken = put({ appearance: { theme: 'dark' } }, { 'x-ashlr-token': 'wrong' });
    await dispatch(wrongToken.req, wrongToken.res, true);
    expect(wrongToken.captured.statusCode).toBe(401);

    expect(fileBytes()).toBe(before);
    expect(readUiSettings().settings.appearance.theme).toBe('light');
  });

  it('is a 415 without a JSON content type; bytes unchanged', async () => {
    seedFile(JSON.stringify({ appearance: { theme: 'light' } }));
    const before = fileBytes();
    const { req, res, captured } = makeFakeReqRes({
      method: 'PUT',
      headers: { 'x-ashlr-token': TEST_TOKEN, 'content-type': 'text/plain' },
      body: JSON.stringify({ appearance: { theme: 'dark' } }),
    });
    await dispatch(req, res, true);
    expect(captured.statusCode).toBe(415);
    expect(fileBytes()).toBe(before);
  });

  it('is a 400 on malformed JSON; bytes unchanged', async () => {
    seedFile(JSON.stringify({ appearance: { theme: 'light' } }));
    const before = fileBytes();
    const { req, res, captured } = put('{not json');
    await dispatch(req, res, true);
    expect(captured.statusCode).toBe(400);
    expect(fileBytes()).toBe(before);
  });

  it('drops invalid fields with problems and never overwrites good stored values', async () => {
    seedFile(JSON.stringify({ appearance: { theme: 'dark', density: 'compact' } }));
    const { req, res, captured } = put({
      appearance: { theme: 'neon', density: 'compact', accentL: 5, accentH: -10, bogus: 1 },
      layout: { sidebarWidth: 9999, resourcesOpen: 'yes' },
      extra: {},
    });
    await dispatch(req, res, true);
    expect(captured.statusCode).toBe(200);
    const body = json(captured);
    expect(body.settings.appearance).toMatchObject({
      theme: 'dark',        // invalid enum dropped; stored value kept
      density: 'compact',
      accentL: 30,          // clamped to min
      accentH: 350,         // hue wraps
    });
    expect(body.settings.layout).toMatchObject({ sidebarWidth: 360, resourcesOpen: true });
    expect(body.problems.sort()).toEqual([
      'invalid value for "appearance.theme"',
      'invalid value for "layout.resourcesOpen"',
      'unknown group "extra"',
      'unknown setting "appearance.bogus"',
    ]);
  });

  it('rejects other methods', async () => {
    const { req, res, captured } = makeFakeReqRes({ method: 'DELETE' });
    await dispatch(req, res, true);
    expect(captured.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Fail-safe file handling
// ---------------------------------------------------------------------------

describe('corrupt, oversized and unsafe ui.json', () => {
  it('corrupt JSON: GET reports parsed:false + problem, defaults returned; valid PUT replaces it', async () => {
    seedFile('{ not json');
    const { req, res, captured } = get();
    await dispatch(req, res, false);
    const body = json(captured);
    expect(body.exists).toBe(true);
    expect(body.parsed).toBe(false);
    expect(body.problems).toEqual(['file is not valid JSON']);
    expect(body.settings).toEqual(defaultUiSettings());

    const w = put({ appearance: { density: 'compact' } });
    await dispatch(w.req, w.res, true);
    expect(w.captured.statusCode).toBe(200);
    expect(readUiSettings()).toMatchObject({ parsed: true });
    expect(readUiSettings().settings.appearance.density).toBe('compact');
  });

  it('oversized file: GET fails safe with a size problem and does not expose a path', async () => {
    mkdirSync(uiSettingsDir(), { recursive: true });
    writeFileSync(uiSettingsPath(), `{"pad":"${'x'.repeat(MAX_UI_SETTINGS_FILE_BYTES)}"}`, 'utf8');
    const { req, res, captured } = get();
    await dispatch(req, res, false);
    const body = json(captured);
    expect(body.parsed).toBe(false);
    expect(body.problems).toEqual(['file exceeds the size limit']);
    expect(JSON.stringify(body.problems)).not.toContain(home);
    expect(readUiSettings().parsed).toBe(false);
  });

  it('symlink: GET refuses to follow it, PUT refuses to replace it, target untouched', async () => {
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ appearance: { theme: 'dark' } }), 'utf8');
    mkdirSync(uiSettingsDir(), { recursive: true });
    symlinkSync(target, uiSettingsPath());

    const { req, res, captured } = get();
    await dispatch(req, res, false);
    const body = json(captured);
    expect(body.parsed).toBe(false);
    expect(body.problems).toEqual(['file is not a regular file']);

    const w = put({ appearance: { theme: 'light' } });
    await dispatch(w.req, w.res, true);
    expect(w.captured.statusCode).toBe(500);

    // The symlink still points at the same target and its bytes are unchanged.
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify({ appearance: { theme: 'dark' } }));
    expect(readUiSettings().parsed).toBe(false);
  });
});
