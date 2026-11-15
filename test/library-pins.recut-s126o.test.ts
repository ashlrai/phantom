/**
 * Recut coverage for the Library pins console slice of #4366 (RQ-PHX-RECUTDESKO1S126):
 * the `library-pins` mount in verse-api.ts must resolve to the real
 * handleLibraryPinsApi module on master's current code, and the mounted route
 * must keep the V1 contract — GET open to the read session, non-GET gated.
 */
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLibraryPinsApi, VERSE_LIBRARY_PINS_PATH } from '../src/core/verse/library-pins-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { mountedApiModules, setMountedApiModulesForTest } from '../src/core/verse/verse-api.js';

afterEach(async () => {
  setMountedApiModulesForTest(null);
  vi.restoreAllMocks();
  await rm(join(homedir(), '.phantom', 'library-pins.json'), { force: true });
});

async function call(method: string, path: string, body = '', headers: Record<string, string> = { 'x-ashlr-token': 't'.repeat(64), 'content-type': 'application/json' }) {
  const req = Readable.from([body]) as unknown as IncomingMessage;
  req.url = path; req.method = method; req.headers = headers;
  let output = '';
  const res = { statusCode: 0, setHeader: vi.fn(), writeHead(n: number) { this.statusCode = n; }, end(v: string) { output = v; } } as unknown as ServerResponse;
  const ctx = { token: 't'.repeat(64), allowDispatch: true } as unknown as VerseApiContext;
  const handled = await handleLibraryPinsApi(ctx, req, res, path, method);
  return { handled, status: res.statusCode, json: () => JSON.parse(output) as Record<string, unknown> };
}

describe('library-pins mount on the real table (recut s126o)', () => {
  it('mounts last, after fleet-slow-prs, and resolves to the real handler', async () => {
    const ids = mountedApiModules().map((m) => m.id);
    expect(ids.at(-1)).toBe('library-pins');
    expect(ids.at(-2)).toBe('fleet-slow-prs');
    const entry = mountedApiModules().find((m) => m.id === 'library-pins');
    expect(await entry!.load()).toBe(handleLibraryPinsApi);
  });

  it('the mounted handler serves GET and gates POST behind the mutation token', async () => {
    expect((await call('GET', VERSE_LIBRARY_PINS_PATH)).json()).toEqual({ v: 1, pins: [] });
    const denied = await call('POST', VERSE_LIBRARY_PINS_PATH, JSON.stringify({ kind: 'note', ref: 'r', title: 't' }), { 'content-type': 'application/json' });
    expect(denied.status).toBe(401);
    const added = await call('POST', VERSE_LIBRARY_PINS_PATH, JSON.stringify({ kind: 'note', ref: 'docs/PLAN.md', title: 'plan of record' }));
    expect(added.status).toBe(200);
    expect(added.json().pins).toHaveLength(1);
  });

  it('declines paths outside /api/verse/library/pins and rejects sub-paths that are not an id', async () => {
    expect((await call('GET', '/api/verse/library')).handled).toBe(false);
    expect((await call('GET', '/api/verse/library/pins/a/b')).handled).toBe(false);
    expect((await call('GET', '/api/verse/library/pins')).handled).toBe(true);
  });
});
