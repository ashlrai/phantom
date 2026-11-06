import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createMergePaceApi } from '../src/core/verse/merge-pace-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const text = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'a', ts: new Date(now - 3_600_000).toISOString(),
  url: 'https://github.com/example/one/pull/3', ttm_s: 360 });
async function call(read: () => Promise<string | null>, path: string, method: string) {
  const out = { status: 0, body: '' };
  const res = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.body = b ?? ''; },
    setHeader: () => {}, statusCode: 0 } as unknown as ServerResponse;
  const handled = await createMergePaceApi(read, () => now)({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, ...out, json: out.body ? JSON.parse(out.body) : null };
}
const path = '/api/verse/fleet/merge-pace';

it('returns the report on GET', async () => {
  const r = await call(async () => text, path, 'GET');
  expect(r.handled).toBe(true);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ schema: 'fleet.merge-pace.v1', known: true, rows: [{ repo: 'example/one', merges: 1 }, { repo: 'total' }] });
});
it('answers 405 on POST and ignores other paths', async () => {
  expect((await call(async () => text, path, 'POST'))).toMatchObject({ handled: true, status: 405 });
  expect((await call(async () => text, '/api/verse/fleet/other', 'GET')).handled).toBe(false);
});
it('serves known:false with status 200 when the reader throws', async () => {
  const r = await call(async () => { throw new Error('/secret/path boom'); }, path, 'GET');
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ known: false, rows: null });
  expect(r.body).not.toContain('secret');
});
