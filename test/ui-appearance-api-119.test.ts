/**
 * GET/PUT /api/verse/appearance — drives the real handler in-process under a
 * temp runs dir. GET is a read like every other verse GET; PUT is gated like
 * the Leader attachment POST (404 without dispatch, then x-ashlr-token).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUiAppearance, VERSE_UI_APPEARANCE_PATH } from '../src/core/verse/ui-appearance-api.js';
import { handleVerseApi } from '../src/core/verse/verse-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'appearance-api-test-token';
let runs = '';
let saved: string | undefined;
let ctx: VerseApiContext;

interface Reply { status: number; body: Record<string, unknown> }

function rec(): { res: ServerResponse; reply: Reply } {
  const reply: Reply = { status: 0, body: {} };
  const rec = {
    headersSent: false,
    writeHead(code: number) { reply.status = code; return rec; },
    setHeader() { return rec; },
    end(chunk?: Buffer | string) { if (chunk) reply.body = JSON.parse(String(chunk)) as Record<string, unknown>; return rec; },
  };
  return { res: rec as unknown as ServerResponse, reply };
}

async function call(method: string, body?: unknown, headers: Record<string, string> = {}, url = VERSE_UI_APPEARANCE_PATH) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [raw] : []), {
    method, url,
    headers: { 'x-ashlr-token': TOKEN, 'content-type': 'application/json', ...headers },
  }) as unknown as IncomingMessage;
  const { res, reply } = rec();
  await handleUiAppearance(ctx, req, res, method);
  return reply;
}

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'ui-appearance-api-119-'));
  saved = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
});
afterEach(() => {
  if (saved === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = saved;
  rmSync(runs, { recursive: true, force: true });
});

describe('GET /api/verse/appearance', () => {
  it('answers the empty record when nothing is stored, then the file once written', async () => {
    expect((await call('GET')).body).toEqual({ revision: 0, appearance: null });
    const put = await call('PUT', { expectedRevision: 0, appearance: { theme: 'dark', density: 'compact' }, updatedBy: 'test' });
    expect(put.status).toBe(200);
    const get = await call('GET');
    expect(get.body).toMatchObject({
      version: 1, revision: 1, updatedBy: 'test',
      appearance: { theme: 'dark', density: 'compact' },
    });
  });

  it('rejects a query string and a non-GET/PUT method', async () => {
    expect((await call('GET', undefined, {}, `${VERSE_UI_APPEARANCE_PATH}?x=1`)).status).toBe(400);
    expect((await call('POST', {})).status).toBe(405);
  });
});

describe('PUT /api/verse/appearance', () => {
  it('writes revision+1 and normalizes the appearance', async () => {
    const res = await call('PUT', { expectedRevision: 0, appearance: { theme: 'dark', accentL: 99, bogus: 'dropped' }, updatedBy: 'cli' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 1, revision: 1, updatedBy: 'cli',
      appearance: { theme: 'dark', accentL: 78, density: 'comfortable' },
    });
  });

  it('answers 409 on a revision mismatch with the current record', async () => {
    expect((await call('PUT', { expectedRevision: 0, appearance: { theme: 'dark' } })).status).toBe(200);
    const stale = await call('PUT', { expectedRevision: 0, appearance: { theme: 'light' } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSE_REVISION_CONFLICT', revision: 1, appearance: { theme: 'dark' } });
    const fresh = await call('PUT', { expectedRevision: 1, appearance: { theme: 'light' } });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ revision: 2, appearance: { theme: 'light' } });
  });

  it('refuses without dispatch (404) and without the token (401)', async () => {
    ctx = { ...ctx, allowDispatch: false };
    expect((await call('PUT', { expectedRevision: 0, appearance: {} })).status).toBe(404);
    ctx = { ...ctx, allowDispatch: true };
    expect((await call('PUT', { expectedRevision: 0, appearance: {} }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await call('PUT', { expectedRevision: 0, appearance: {} }, { 'x-ashlr-token': '' })).status).toBe(401);
    // And the writes never happened.
    expect((await call('GET')).body).toEqual({ revision: 0, appearance: null });
  });

  it('rejects malformed bodies as 400s', async () => {
    for (const bad of [
      undefined, 'x', {},
      { expectedRevision: '0', appearance: {} },
      { expectedRevision: -1, appearance: {} },
      { expectedRevision: 0 },
      { expectedRevision: 0, appearance: 'dark' },
      { expectedRevision: 0, appearance: {}, extra: 1 },
      { expectedRevision: 0, appearance: {}, updatedBy: 7 },
    ]) {
      expect((await call('PUT', bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('is reachable through handleVerseApi like a V1 path', async () => {
    const raw = JSON.stringify({ expectedRevision: 0, appearance: { theme: 'dark' }, updatedBy: 'route-test' });
    const req = Object.assign(Readable.from([raw]), {
      method: 'PUT', url: VERSE_UI_APPEARANCE_PATH,
      headers: { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    const { res, reply } = rec();
    expect(await handleVerseApi(ctx, req, res, VERSE_UI_APPEARANCE_PATH, 'PUT')).toBe(true);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ revision: 1, updatedBy: 'route-test' });
  });
});
