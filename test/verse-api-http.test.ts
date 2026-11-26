import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import { hasNoQuery, readMutationBody, readQuery, sendInvalid } from '../src/core/verse/api-http.js';

function fakeRes() {
  const out = { status: 0, body: null as unknown, res: null as unknown as ServerResponse };
  out.res = {
    headersSent: false,
    writeHead(status: number) { out.status = status; (this as { headersSent: boolean }).headersSent = true; return this; },
    end(payload?: string) { out.body = payload ? (JSON.parse(payload) as unknown) : null; return this; },
  } as unknown as ServerResponse;
  return out;
}

function fakeReq(opts: { url?: string; headers?: Record<string, string>; body?: string } = {}): IncomingMessage {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, { url: opts.url ?? '/api/verse/test', headers: opts.headers ?? {} }) as unknown as IncomingMessage;
  queueMicrotask(() => {
    if (opts.body) emitter.emit('data', Buffer.from(opts.body, 'utf8'));
    emitter.emit('end');
  });
  return req;
}

const CTX = { allowDispatch: true, token: 'test-token' };
const HEADERS = { 'x-ashlr-token': 'test-token', 'content-type': 'application/json' };

describe('verse api-http helpers', () => {
  it('sendInvalid writes 400 VERSE_INVALID', () => {
    const out = fakeRes();
    sendInvalid(out.res, 'bad input');
    expect(out).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'bad input' } });
  });

  it('readQuery and hasNoQuery allow valid params and reject unknown or malformed queries', () => {
    const ok = fakeRes();
    expect(readQuery(fakeReq({ url: '/api/verse/ops/board?team=core' }), ok.res, ['team'])?.get('team')).toBe('core');
    expect(ok.status).toBe(0);
    const unknown = fakeRes();
    expect(readQuery(fakeReq({ url: '/api/verse/ops/board?team=core&extra=1' }), unknown.res, ['team'])).toBeNull();
    expect(unknown).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'unknown query parameter: extra' } });
    const malformed = fakeRes();
    expect(readQuery(fakeReq({ url: 'http://[::1' }), malformed.res, [])).toBeNull();
    expect(malformed).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'invalid query string' } });
    const clean = fakeRes();
    expect(hasNoQuery(fakeReq({ url: '/api/verse/overnight' }), clean.res)).toBe(true);
    expect(clean.status).toBe(0);
    const dirty = fakeRes();
    expect(hasNoQuery(fakeReq({ url: '/api/verse/overnight?force=1' }), dirty.res)).toBe(false);
    expect(dirty).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'unknown query parameter: force' } });
  });

  it('readMutationBody enforces dispatch, auth, content-type, query, size and JSON-object guards', async () => {
    const noDispatch = fakeRes();
    expect(await readMutationBody({ allowDispatch: false, token: 'test-token' }, fakeReq({ headers: HEADERS }), noDispatch.res)).toBeNull();
    expect(noDispatch.status).toBe(404);
    const badToken = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ headers: { ...HEADERS, 'x-ashlr-token': 'wrong' } }), badToken.res)).toBeNull();
    expect(badToken.status).toBe(401);
    const badType = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ headers: { ...HEADERS, 'content-type': 'text/plain' } }), badType.res)).toBeNull();
    expect(badType.status).toBe(415);
    const withQuery = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ url: '/api/verse/test?foo=1', headers: HEADERS, body: '{}' }), withQuery.res, { rejectQuery: true })).toBeNull();
    expect(withQuery).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'unknown query parameter: foo' } });
    const tooLarge = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ headers: HEADERS, body: '{"a":"0123456789"}' }), tooLarge.res, { maxBytes: 8 })).toBeNull();
    expect(tooLarge).toMatchObject({ status: 413, body: { code: 'VERSE_TOO_LARGE', error: 'request body too large' } });
    const badJson = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ headers: HEADERS, body: '{not-json' }), badJson.res)).toBeNull();
    expect(badJson).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'invalid JSON body' } });
    for (const nonObject of ['[]', 'null', '"text"', '42']) {
      const out = fakeRes();
      expect(await readMutationBody(CTX, fakeReq({ headers: HEADERS, body: nonObject }), out.res)).toBeNull();
      expect(out).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'body must be a JSON object' } });
    }
  });

  it('readMutationBody returns {} for empty bodies and parses valid JSON objects', async () => {
    const emptyOut = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ headers: HEADERS, body: '' }), emptyOut.res)).toEqual({});
    expect(emptyOut.status).toBe(0);
    const okOut = fakeRes();
    expect(await readMutationBody(CTX, fakeReq({ headers: HEADERS, body: '{"action":"arm","ok":true}' }), okOut.res)).toEqual({ action: 'arm', ok: true });
    expect(okOut.status).toBe(0);
  });
});
