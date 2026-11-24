import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdLibrary } from '../src/cli/library.js';
import * as library from '../src/core/fleet/library.js';
import * as files from '../src/core/fleet/library-files.js';
import { createFleetLibraryFilesApi, VERSE_FLEET_LIBRARY_FILES_PATH } from '../src/core/verse/fleet-library-files-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
const PATH = `${VERSE_FLEET_LIBRARY_FILES_PATH}/items`;
const TOKEN = 'synthetic-library-test-token';
const snapshot: library.LibrarySnapshot = { v: 1, asOf: '2026-11-17T12:00:00Z', items: [], unavailable: [] };
afterEach(() => vi.restoreAllMocks());
async function call(query = '', expiresAt: number | null = Date.now() + 60_000, allowDispatch = true, method = 'GET', fail = false, token: string | null = TOKEN) {
  const readLibrary = vi.fn().mockImplementation(async () => { if (fail) throw new Error('private diagnostic'); return snapshot; });
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const ctx = { token: TOKEN, allowDispatch, readSession: expiresAt === null ? undefined : { expiresAt } } as VerseApiContext;
  await createFleetLibraryFilesApi({ readLibrary })(ctx, { url: PATH + query, headers: token === null ? {} : { 'x-ashlr-token': token } } as IncomingMessage, res, PATH, method);
  return { status, body: JSON.parse(text), readLibrary };
}
it('uses the existing Library family and passes the three filters to the shared reader', async () => {
  expect(workbenchFamilyFor(PATH)?.id).toBe('fleet-library-files');
  const result = await call('?kind=memory&since=1h&q=plain%20words');
  expect(result.status).toBe(200);
  expect(result.body).toEqual(snapshot);
  expect(result.readLibrary).toHaveBeenCalledWith({ kind: 'memory', since: '1h', q: 'plain words' }, expect.any(Object));
});
it.each(['?kind=other', '?since=never', '?extra=x', '?kind=file&kind=memory'])('rejects invalid filters %s without reading', async query => {
  const result = await call(query);
  expect(result.status).toBe(400);
  expect(result.readLibrary).not.toHaveBeenCalled();
});
it.each([null, 0, Number.NaN, Number.POSITIVE_INFINITY])('requires a current read session (%s)', async expiry => {
  const result = await call('', expiry);
  expect(result.status).toBe(401);
  expect(result.readLibrary).not.toHaveBeenCalled();
});
it.each([null, 'wrong'])('preserves the media token gate (%s)', async token => {
  const result = await call('', Date.now() + 60_000, true, 'GET', false, token);
  expect(result.status).toBe(401);
  expect(result.readLibrary).not.toHaveBeenCalled();
});
it('preserves dispatch and method gates, and never returns failure details', async () => {
  expect((await call('', Date.now() + 60_000, false)).status).toBe(404);
  expect((await call('', Date.now() + 60_000, true, 'POST')).status).toBe(405);
  const failed = await call('', Date.now() + 60_000, true, 'GET', true);
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual({ error: 'Library unavailable.' });
});
it('prints the shared JSON, text empty state, and unchanged legacy file shape', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(library, 'readLibrary').mockResolvedValue(snapshot);
  vi.spyOn(files, 'listLeaderFiles').mockResolvedValue([]);
  expect(await cmdLibrary(['--json', '--kind', 'context', '--since', '1h', '--q', 'notes'])).toBe(0);
  expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toEqual(snapshot);
  expect(await cmdLibrary(['--text'])).toBe(0);
  expect(output).toHaveBeenLastCalledWith('No matching Library items.');
  expect(await cmdLibrary(['list', '--json'])).toBe(0);
  expect(output).toHaveBeenLastCalledWith('{"files":[]}');
});
it.each([['--kind'], ['--json', '--text'], ['--kind', 'file', '--kind', 'memory'], ['--unknown']].map(args => ({ args })))('rejects malformed CLI flags $args', async ({ args }) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.spyOn(library, 'readLibrary');
  expect(await cmdLibrary(args)).toBe(2);
  expect(read).not.toHaveBeenCalled();
});
