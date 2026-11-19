import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { AppUpdateStatus } from '../src/core/app-update-status.js';
import type { ReleaseNotes } from '../src/core/release/notes.js';
import { createAppUpdateApi, VERSE_APP_UPDATE_STATUS_PATH, VERSE_APP_WHATS_NEW_PATH, type AppUpdateApiDeps } from '../src/core/verse/app-update-api.js';

// Synthetic notes: only `headline` and `sections` reach the wire, so the rest is empty.
const notesFor = (since: string): ReleaseNotes => ({
  schema: 'phantom.release-notes.v1', since, head: 'HEAD', summary: [], headline: ['Synthetic change'], sections: [], groups: {},
} as unknown as ReleaseNotes);

// The native status module is replaced by a counted stub: its factory runs only
// when something imports it, so `loads.count` is the import-time evidence.
const native = vi.hoisted(() => ({
  loads: { count: 0 },
  readAppUpdateStatus: vi.fn<(deps: unknown) => AppUpdateStatus>(),
  readInstalledBundleVersion: vi.fn<() => string | null>(),
}));

vi.mock('../src/core/app-update-status.js', () => {
  native.loads.count += 1;
  return {
    readAppUpdateStatus: (deps: unknown) => native.readAppUpdateStatus(deps),
    readInstalledBundleVersion: () => native.readInstalledBundleVersion(),
    defaultAppUpdateStatusDeps: () => ({}),
  };
});

const STATUS = VERSE_APP_UPDATE_STATUS_PATH;
const WHATS_NEW = VERSE_APP_WHATS_NEW_PATH;

const staged = (over: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  current: null, available: null, deferredReason: null, runningJobs: null,
  runningJobCount: null, unknownJobs: null, ...over,
});

const UNAVAILABLE = { v: 1, available: null, deferredReason: 'native-status-unavailable', runningJobCount: null, unknownJobs: null };

type Api = ReturnType<typeof createAppUpdateApi>;

async function call(api: Api, o: { path?: string; method?: string } = {}) {
  const path = o.path ?? STATUS;
  const method = o.method ?? 'GET';
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = path;
  req.method = method;
  req.headers = {};
  let status = 0;
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { raw = text; },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: 'app-update-lazy-test', allowDispatch: true } as VerseApiContext;
  const handled = await api(ctx, req, res, path, method);
  return { handled, status, raw, wire: raw ? JSON.parse(raw) as Record<string, unknown> : null };
}

const make = (over: AppUpdateApiDeps = {}) => createAppUpdateApi(over);

beforeEach(() => {
  native.readAppUpdateStatus.mockReset();
  native.readInstalledBundleVersion.mockReset();
});

describe('app update status: lazy default reader and awaited reads', () => {
  it('awaits a resolved async reader and reports its values', async () => {
    const api = make({ readStatus: async () => staged({ available: '9.9.9', deferredReason: 'work-active-or-unknown', runningJobCount: 2, unknownJobs: 0 }) });
    expect(await call(api)).toEqual({ handled: true, status: 200, raw: expect.any(String),
      wire: { v: 1, available: '9.9.9', deferredReason: 'work-active-or-unknown', runningJobCount: 2, unknownJobs: 0 } });
  });

  it('answers the sanitized unavailable shape when an async reader rejects, without the error text', async () => {
    const api = make({ readStatus: () => Promise.reject(new Error('inert fixture /tmp/not-real/secret-path')) });
    const r = await call(api);
    expect(r.status).toBe(200);
    expect(r.wire).toEqual(UNAVAILABLE);
    expect(r.raw).not.toContain('inert fixture');
    expect(r.raw).not.toContain('secret-path');
  });

  it('keeps synchronous injected readers working unchanged', async () => {
    const api = make({ readStatus: () => staged({ available: '9.9.8', unknownJobs: 1 }) });
    expect((await call(api)).wire).toEqual({ v: 1, available: '9.9.8', deferredReason: null, runningJobCount: null, unknownJobs: 1 });
  });

  it('sanitizes a synchronous throw to the unavailable shape without exception text', async () => {
    const api = make({ readStatus: () => { throw new Error('inert sync fixture'); } });
    const r = await call(api);
    expect(r.wire).toEqual(UNAVAILABLE);
    expect(r.raw).not.toContain('inert sync fixture');
  });

  it('still refuses non-GET methods on the status route', async () => {
    const api = make({ readStatus: async () => staged({ available: '9.9.9' }) });
    expect(await call(api, { method: 'POST' })).toEqual({ handled: true, status: 405, raw: expect.any(String), wire: { error: 'method not allowed' } });
  });
});

describe('app update api: module import and route laziness', () => {
  // Order matters: the mock factory is cached per file, so this import-time proof must run before
  // any test that requests the default reader (vitest runs declarations in order).
  it('does not load the native status module at construction, or on injected whats-new and status routes', async () => {
    vi.resetModules();
    native.loads.count = 0;
    const api = (await import('../src/core/verse/app-update-api.js')).createAppUpdateApi({
      readStatus: async () => staged({ available: '9.9.9' }),
      readInstalled: () => '9.9.9',
      readNotes: notesFor,
    });
    expect(native.loads.count).toBe(0);
    expect((await call(api, { path: WHATS_NEW })).wire).toMatchObject({ installed: '9.9.9', reason: null });
    expect((await call(api)).wire).toMatchObject({ available: '9.9.9' });
    expect(native.loads.count).toBe(0);
  });

  it('loads the native status module on the first default status request, then reads through it', async () => {
    vi.resetModules();
    native.loads.count = 0;
    native.readAppUpdateStatus.mockReturnValue(staged({ available: '8.8.8', deferredReason: 'native-status-unavailable' }));
    const api = (await import('../src/core/verse/app-update-api.js')).createAppUpdateApi();
    expect(native.loads.count).toBe(0);
    expect((await call(api)).wire).toEqual({ v: 1, available: '8.8.8', deferredReason: 'native-status-unavailable', runningJobCount: null, unknownJobs: null });
    expect(native.loads.count).toBe(1);
    expect(native.readAppUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it('sanitizes a failed default status load to the unavailable shape', async () => {
    native.readAppUpdateStatus.mockImplementation(() => { throw new Error('inert native failure'); });
    const r = await call(make());
    expect(r.wire).toEqual(UNAVAILABLE);
    expect(r.raw).not.toContain('inert native failure');
  });
});

describe('whats-new route is preserved', () => {
  it('returns notes since the injected installed version', async () => {
    const readNotes = vi.fn(notesFor);
    const api = make({ readInstalled: () => '9.9.9', readNotes });
    const r = await call(api, { path: WHATS_NEW });
    expect(r).toEqual({ handled: true, status: 200, raw: expect.any(String),
      wire: { v: 1, installed: '9.9.9', headline: ['Synthetic change'], sections: [], reason: null } });
    expect(readNotes).toHaveBeenCalledWith('v9.9.9');
  });

  it('reads an unknown installed version as unknown, with no notes read', async () => {
    const readNotes = vi.fn(notesFor);
    const api = make({ readInstalled: () => null, readNotes });
    expect((await call(api, { path: WHATS_NEW })).wire)
      .toEqual({ v: 1, installed: null, headline: [], sections: [], reason: 'installed-version-unknown' });
    expect(readNotes).not.toHaveBeenCalled();
  });

  it('treats a throwing installed-version reader as unknown', async () => {
    const api = make({ readInstalled: () => { throw new Error('inert installed fixture'); }, readNotes: notesFor });
    const r = await call(api, { path: WHATS_NEW });
    expect(r.wire).toEqual({ v: 1, installed: null, headline: [], sections: [], reason: 'installed-version-unknown' });
    expect(r.raw).not.toContain('inert installed fixture');
  });

  it('reports history-unavailable when the notes read throws, without exception text', async () => {
    const api = make({ readInstalled: () => '9.9.9', readNotes: () => { throw new Error('inert git fixture'); } });
    const r = await call(api, { path: WHATS_NEW });
    expect(r.wire).toEqual({ v: 1, installed: '9.9.9', headline: [], sections: [], reason: 'history-unavailable' });
    expect(r.raw).not.toContain('inert git fixture');
  });

  it('sanitizes an unsafe installed version to unknown', async () => {
    const api = make({ readInstalled: () => '/Users/mason/escape', readNotes: notesFor });
    expect((await call(api, { path: WHATS_NEW })).wire).toMatchObject({ installed: null, reason: 'installed-version-unknown' });
  });

  it('reads the default installed version through the lazy native module', async () => {
    native.readInstalledBundleVersion.mockReturnValue('9.9.9');
    const api = make({ readNotes: notesFor });
    expect((await call(api, { path: WHATS_NEW })).wire).toMatchObject({ installed: '9.9.9', reason: null });
  });

  it('refuses non-GET methods and declines other paths', async () => {
    const api = make();
    expect(await call(api, { path: WHATS_NEW, method: 'POST' })).toEqual({ handled: true, status: 405, raw: expect.any(String), wire: { error: 'method not allowed' } });
    expect((await call(api, { path: '/api/verse/app/whats-new/extra' })).handled).toBe(false);
  });
});
