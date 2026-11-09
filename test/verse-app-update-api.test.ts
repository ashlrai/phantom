import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createAppUpdateApi, VERSE_APP_UPDATE_STATUS_PATH, type AppUpdateApiDeps } from '../src/core/verse/app-update-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import type { AppUpdateStatus } from '../src/core/app-update-status.js';

const PATH = VERSE_APP_UPDATE_STATUS_PATH;

const staged = (over: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  current: null, available: null, deferredReason: null, runningJobs: null,
  runningJobCount: null, unknownJobs: null, ...over,
});

async function call(api: ReturnType<typeof createAppUpdateApi>, o: { path?: string; method?: string; allowDispatch?: boolean } = {}) {
  const path = o.path ?? PATH;
  const method = o.method ?? 'GET';
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = path;
  req.method = method;
  req.headers = {};
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: 'app-update-test', allowDispatch: o.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, path, method);
  return { handled, status, wire };
}
const make = (over: AppUpdateApiDeps = {}) => createAppUpdateApi(over);

describe('app update status api', () => {
  it('mounts under its own workbench family', () => {
    expect(workbenchFamilyFor(PATH)?.id).toBe('app-update');
    expect(workbenchFamilyFor(`${PATH}/extra`)?.id).toBe('app-update');
    expect(workbenchFamilyFor('/api/verse/app/other')).toBeNull();
  });

  it('reports the staged version, hold and lease counts', async () => {
    const api = make({ readStatus: () => staged({ available: '3.30.2', deferredReason: 'work-active-or-unknown', runningJobCount: 3, unknownJobs: 1 }) });
    const r = await call(api);
    expect(r).toEqual({ handled: true, status: 200,
      wire: { v: 1, available: '3.30.2', deferredReason: 'work-active-or-unknown', runningJobCount: 3, unknownJobs: 1 } });
  });

  it('reports a ready candidate and an empty stage verbatim', async () => {
    expect((await call(make({ readStatus: () => staged({ available: '3.30.2' }) }))).wire)
      .toEqual({ v: 1, available: '3.30.2', deferredReason: null, runningJobCount: null, unknownJobs: null });
    expect((await call(make({ readStatus: () => staged({ deferredReason: 'native-status-unavailable' }) }))).wire)
      .toEqual({ v: 1, available: null, deferredReason: 'native-status-unavailable', runningJobCount: null, unknownJobs: null });
  });

  it('nulls strings that are not short tokens, and counts that are not non-negative integers', async () => {
    const readStatus = () => staged({
      available: '/Users/mason/escape', deferredReason: `held: ${'x'.repeat(81)}`,
      runningJobCount: -1, unknownJobs: 1.5,
    });
    expect((await call(make({ readStatus }))).wire)
      .toEqual({ v: 1, available: null, deferredReason: null, runningJobCount: null, unknownJobs: null });
    const wordy = staged({ deferredReason: 'authority reapproval required', runningJobCount: 0, unknownJobs: 0 });
    expect((await call(make({ readStatus: () => wordy }))).wire)
      .toEqual({ v: 1, available: null, deferredReason: 'authority reapproval required', runningJobCount: 0, unknownJobs: 0 });
  });

  it('answers 200 with native-status-unavailable when the read throws', async () => {
    const api = make({ readStatus: () => { throw new Error('boom'); } });
    const r = await call(api);
    expect(r).toEqual({ handled: true, status: 200,
      wire: { v: 1, available: null, deferredReason: 'native-status-unavailable', runningJobCount: null, unknownJobs: null } });
  });

  it('is a read route: GET answers without dispatch, other methods are 405', async () => {
    const api = make({ readStatus: () => staged({ available: '3.30.2' }) });
    expect((await call(api, { allowDispatch: false })).status).toBe(200);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const r = await call(api, { method });
      expect(r, method).toEqual({ handled: true, status: 405, wire: { error: 'method not allowed' } });
    }
  });

  it('declines other paths so the mount can 404 them', async () => {
    const api = make();
    expect((await call(api, { path: '/api/verse/app' })).handled).toBe(false);
    expect((await call(api, { path: '/api/verse/app/other' })).handled).toBe(false);
    expect((await call(api, { path: `${PATH}/extra` })).handled).toBe(false);
  });
});
