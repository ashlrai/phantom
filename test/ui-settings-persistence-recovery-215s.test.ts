/**
 * Recovered from ashlrai/phantom PR #5119, head
 * 7b1e49a1476e766d0f6b476fdb1070c186afc7dd, path
 * test/ui-settings-persistence-recovery-141.test.ts (itself recovered from
 * PR #4974). Adapted to CURRENT master contracts; see BRIDGE_NOTES.md.
 *
 * Behaviour through the REAL handleApi dispatcher that ui-settings.test.ts and
 * the c196/c206 recuts do not pin: a second reader sees persisted values while
 * untouched fields survive, every rejected request (404/401/415/400) leaves the
 * stored bytes unchanged, invalid fields never overwrite good stored values,
 * and symlinked / oversized / corrupt ui.json never corrupts a link target.
 *
 * Current contract notes: GET is served with dispatch disabled (read-only
 * observers); only PUT is gated. Production applies no size cap or symlink
 * refusal on the file read, so those cases pin only the invariants that hold
 * today (no path leak, target bytes untouched), not a refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig } from '../src/core/config.js';
import { defaultUiSettings, readUiSettings, uiSettingsPath } from '../src/core/ui-settings.js';
import { handleApi } from '../src/core/web/api.js';

const TOKEN = 'fake-token-ui-settings-215s';
const PATH = '/api/ui-settings';

let home: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;

beforeEach(() => {
  prevHome = process.env['HOME'];
  prevProfile = process.env['USERPROFILE'];
  home = mkdtempSync(join(tmpdir(), 'ui-settings-215s-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = prevHome;
  if (prevProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = prevProfile;
  rmSync(home, { recursive: true, force: true });
});

interface Captured { statusCode: number; body: string }

function call(method: string, headers: Record<string, string>, body?: string, allowDispatch = true): Promise<Captured> {
  const captured: Captured = { statusCode: 200, body: '' };
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = PATH;
  req.headers = headers;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.statusCode = status; this.headersSent = true; },
    setHeader() {},
    end(data?: string) { if (data) captured.body += data; },
    write(chunk: string) { captured.body += chunk; return true; },
  } as unknown as ServerResponse;
  return handleApi(req, res, defaultConfig(), { token: TOKEN, allowDispatch }).then((handled) => {
    expect(handled).toBe(true);
    return captured;
  });
}

const JSON_HEADERS = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
const get = (allowDispatch = false) => call('GET', {}, undefined, allowDispatch);
const put = (body: unknown, headers: Record<string, string> = JSON_HEADERS, allowDispatch = true) =>
  call('PUT', headers, typeof body === 'string' ? body : JSON.stringify(body), allowDispatch);
const parse = (c: Captured): any => JSON.parse(c.body);
const bytes = (): string | null => {
  try { return readFileSync(uiSettingsPath(), 'utf8'); } catch { return null; }
};
const seed = (contents: string): void => {
  mkdirSync(join(home, '.ashlr'), { recursive: true });
  writeFileSync(uiSettingsPath(), contents, 'utf8');
};

describe('persistence through handleApi', () => {
  it('a second reader sees a persisted partial patch and untouched fields survive', async () => {
    expect((await put({ appearance: { theme: 'dark' } })).statusCode).toBe(200);
    expect((await put({ layout: { resourcesOpen: false } })).statusCode).toBe(200);

    const body = parse(await get());
    expect(body).toMatchObject({ exists: true, parsed: true, problems: [] });
    expect(body.settings.appearance.theme).toBe('dark');
    expect(body.settings.layout.resourcesOpen).toBe(false);
    expect(body.settings.appearance.accentH).toBe(defaultUiSettings().appearance.accentH);
    // Independent reader straight from the store, and the on-disk document.
    expect(readUiSettings().settings.appearance.theme).toBe('dark');
    const onDisk = JSON.parse(bytes()!);
    expect(onDisk.appearance.theme).toBe('dark');
    expect(onDisk.layout.resourcesOpen).toBe(false);
    expect(onDisk.appearance.accentL).toBe(defaultUiSettings().appearance.accentL);
  });

  it('invalid fields are reported and never overwrite good stored values', async () => {
    seed(JSON.stringify({ appearance: { theme: 'dark', density: 'compact' } }));
    const res = await put({
      appearance: { theme: 'neon', density: 'compact', accentL: 5, accentH: -10, bogus: 1 },
      layout: { sidebarWidth: 9999, resourcesOpen: 'yes' },
      extra: {},
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body.settings.appearance).toMatchObject({ theme: 'dark', density: 'compact', accentL: 30, accentH: 350 });
    expect(body.settings.layout).toMatchObject({ sidebarWidth: 360, resourcesOpen: true });
    expect([...body.problems].sort()).toEqual([
      'invalid value for "appearance.theme"',
      'invalid value for "layout.resourcesOpen"',
      'unknown group "extra"',
      'unknown setting "appearance.bogus"',
    ]);
    // The stored theme survives on disk, not just in the response.
    expect(JSON.parse(bytes()!).appearance.theme).toBe('dark');
  });

  it('DELETE is a 405 and leaves the stored bytes unchanged', async () => {
    seed(JSON.stringify({ appearance: { theme: 'light' } }));
    const before = bytes();
    expect((await call('DELETE', JSON_HEADERS)).statusCode).toBe(405);
    expect(bytes()).toBe(before);
  });
});

describe('rejected PUTs leave the stored bytes unchanged', () => {
  const stored = JSON.stringify({ appearance: { theme: 'light' } });
  const patch = { appearance: { theme: 'dark' } };

  it.each([
    ['dispatch disabled (404)', () => put(patch, JSON_HEADERS, false), 404],
    ['missing token (401)', () => put(patch, { 'content-type': 'application/json' }), 401],
    ['wrong token (401)', () => put(patch, { ...JSON_HEADERS, 'x-ashlr-token': 'wrong' }), 401],
    ['non-JSON content type (415)', () => put(patch, { ...JSON_HEADERS, 'content-type': 'text/plain' }), 415],
    ['malformed JSON (400)', () => put('{not json'), 400],
  ] as const)('%s', async (_name, send, status) => {
    seed(stored);
    expect((await send()).statusCode).toBe(status);
    expect(bytes()).toBe(stored);
    expect(readUiSettings().settings.appearance.theme).toBe('light');
  });

  it('a rejected PUT creates no file when none existed', async () => {
    expect((await put(patch, JSON_HEADERS, false)).statusCode).toBe(404);
    expect(bytes()).toBeNull();
  });
});

describe('corrupt, oversized and symlinked ui.json', () => {
  it('corrupt JSON reads as parsed:false defaults; a valid PUT replaces it', async () => {
    seed('{ not json');
    const body = parse(await get());
    expect(body).toMatchObject({ exists: true, parsed: false, problems: ['file is not valid JSON'] });
    expect(body.settings).toEqual(defaultUiSettings());

    expect((await put({ appearance: { density: 'compact' } })).statusCode).toBe(200);
    expect(readUiSettings().parsed).toBe(true);
    expect(readUiSettings().settings.appearance.density).toBe('compact');
  });

  it('a large foreign document never leaks into settings or exposes a path', async () => {
    seed(`{"pad":"${'x'.repeat(1024 * 1024)}"}`);
    const res = await get();
    const body = parse(res);
    expect(body.settings).toEqual(defaultUiSettings());
    expect(JSON.stringify(body.problems)).not.toContain(home);
    expect(body.problems).toEqual(['unknown group "pad"']);
  });

  it('PUT over a symlinked ui.json never modifies the link target', async () => {
    const target = join(home, 'elsewhere.json');
    const targetBytes = JSON.stringify({ appearance: { theme: 'dark' } });
    writeFileSync(target, targetBytes, 'utf8');
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    symlinkSync(target, uiSettingsPath());

    const res = await put({ appearance: { theme: 'light' } });
    expect([200, 500]).toContain(res.statusCode);
    expect(readFileSync(target, 'utf8')).toBe(targetBytes);
    if (res.statusCode === 200) expect(lstatSync(uiSettingsPath()).isSymbolicLink()).toBe(false);
  });
});
