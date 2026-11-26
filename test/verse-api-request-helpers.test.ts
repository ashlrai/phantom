import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import {
  hasNoQuery,
  readAllowedQuery,
  readMutationBody,
  sendInvalid,
  sendRefused,
} from '../src/core/verse/api-request-helpers.js';

interface RecordedResponse {
  status: number;
  body: Record<string, unknown> | null;
  res: ServerResponse;
}

function makeRes(): RecordedResponse {
  const out: RecordedResponse = {
    status: 0,
    body: null,
    res: null as unknown as ServerResponse,
  };
  out.res = {
    headersSent: false,
    writeHead(code: number) {
      out.status = code;
      (out.res as { headersSent: boolean }).headersSent = true;
      return out.res;
    },
    end(chunk?: string) {
      out.body = chunk ? (JSON.parse(chunk) as Record<string, unknown>) : null;
      return out.res;
    },
  } as unknown as ServerResponse;
  return out;
}

function makeReq(opts: {
  url?: string;
  body?: string;
  token?: string;
  contentType?: string;
} = {}): IncomingMessage {
  const stream = new PassThrough();
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['x-ashlr-token'] = opts.token;
  if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
  Object.assign(stream, { url: opts.url ?? '/api/verse/test', headers });
  if (opts.body !== undefined) stream.end(opts.body);
  else stream.end();
  return stream as unknown as IncomingMessage;
}

describe('verse api-request-helpers', () => {
  it('sends standard VERSE_INVALID and VERSE_REFUSED envelopes', () => {
    const inv = makeRes();
    sendInvalid(inv.res, 'bad input');
    expect(inv.status).toBe(400);
    expect(inv.body).toEqual({ code: 'VERSE_INVALID', error: 'bad input' });

    const ref = makeRes();
    sendRefused(ref.res, 'not allowed');
    expect(ref.status).toBe(409);
    expect(ref.body).toEqual({ code: 'VERSE_REFUSED', error: 'not allowed' });
  });

  it('validates allowed, empty, repeated, and truncated query parameters', () => {
    const okRes = makeRes();
    expect(hasNoQuery(makeReq({ url: '/api/verse/test' }), okRes.res)).toBe(true);
    expect(okRes.status).toBe(0);

    const unknownRes = makeRes();
    const longKey = 'k'.repeat(80);
    expect(hasNoQuery(makeReq({ url: `/api/verse/test?${longKey}=1` }), unknownRes.res, 64)).toBe(false);
    expect(unknownRes.status).toBe(400);
    expect(unknownRes.body).toEqual({
      code: 'VERSE_INVALID',
      error: `unknown query parameter: ${'k'.repeat(64)}`,
    });

    const repeatBlocked = makeRes();
    expect(
      readAllowedQuery(makeReq({ url: '/api/verse/test?a=1&a=2' }), repeatBlocked.res, ['a'], {
        rejectRepeats: true,
      }),
    ).toBeNull();
    expect(repeatBlocked.status).toBe(400);
    expect(repeatBlocked.body).toEqual({
      code: 'VERSE_INVALID',
      error: 'query parameter a may appear only once',
    });

    const repeatAllowed = makeRes();
    const params = readAllowedQuery(
      makeReq({ url: '/api/verse/test?extraRoots=/a&extraRoots=/b' }),
      repeatAllowed.res,
      ['extraRoots'],
      { rejectRepeats: true, repeatable: ['extraRoots'] },
    );
    expect(params?.getAll('extraRoots')).toEqual(['/a', '/b']);
    expect(repeatAllowed.status).toBe(0);
  });

  it('enforces dispatch flag, mutation gate, empty-query guard, and size limit', async () => {
    const offRes = makeRes();
    expect(
      await readMutationBody(
        { allowDispatch: false, token: 'tok' },
        makeReq({ token: 'tok', contentType: 'application/json', body: '{}' }),
        offRes.res,
      ),
    ).toBeNull();
    expect(offRes.status).toBe(404);

    const authRes = makeRes();
    expect(
      await readMutationBody(
        { allowDispatch: true, token: 'tok' },
        makeReq({ token: 'wrong', contentType: 'application/json', body: '{}' }),
        authRes.res,
      ),
    ).toBeNull();
    expect(authRes.status).toBe(401);

    const ctRes = makeRes();
    expect(
      await readMutationBody(
        { allowDispatch: true, token: 'tok' },
        makeReq({ token: 'tok', contentType: 'text/plain', body: '{}' }),
        ctRes.res,
      ),
    ).toBeNull();
    expect(ctRes.status).toBe(415);

    const queryRes = makeRes();
    expect(
      await readMutationBody(
        { allowDispatch: true, token: 'tok' },
        makeReq({ url: '/api/verse/test?foo=1', token: 'tok', contentType: 'application/json', body: '{}' }),
        queryRes.res,
        { requireNoQuery: true },
      ),
    ).toBeNull();
    expect(queryRes.status).toBe(400);
    expect(queryRes.body).toEqual({ code: 'VERSE_INVALID', error: 'unknown query parameter: foo' });

    const largeRes = makeRes();
    expect(
      await readMutationBody(
        { allowDispatch: true, token: 'tok' },
        makeReq({ token: 'tok', contentType: 'application/json', body: '{"x":"1234567890"}' }),
        largeRes.res,
        { maxBytes: 8 },
      ),
    ).toBeNull();
    expect(largeRes.status).toBe(413);
    expect(largeRes.body).toEqual({ code: 'VERSE_TOO_LARGE', error: 'request body too large' });
  });

  it('parses JSON objects with allowEmpty, trimEmpty, non-object, and allowedKeys checks', async () => {
    const ctx = { allowDispatch: true, token: 'tok' };
    const headers = { token: 'tok', contentType: 'application/json' };

    const emptyOk = makeRes();
    expect(await readMutationBody(ctx, makeReq({ ...headers, body: '' }), emptyOk.res)).toEqual({});

    const whitespaceTrimOk = makeRes();
    expect(
      await readMutationBody(ctx, makeReq({ ...headers, body: '   \n' }), whitespaceTrimOk.res, {
        trimEmpty: true,
      }),
    ).toEqual({});

    const emptyDisallowed = makeRes();
    expect(
      await readMutationBody(ctx, makeReq({ ...headers, body: '' }), emptyDisallowed.res, {
        allowEmpty: false,
      }),
    ).toBeNull();
    expect(emptyDisallowed.status).toBe(400);
    expect(emptyDisallowed.body).toEqual({ code: 'VERSE_INVALID', error: 'invalid JSON body' });

    const badJsonRes = makeRes();
    expect(await readMutationBody(ctx, makeReq({ ...headers, body: '{bad' }), badJsonRes.res)).toBeNull();
    expect(badJsonRes.status).toBe(400);
    expect(badJsonRes.body).toEqual({ code: 'VERSE_INVALID', error: 'invalid JSON body' });

    const arrayRes = makeRes();
    expect(await readMutationBody(ctx, makeReq({ ...headers, body: '[]' }), arrayRes.res)).toBeNull();
    expect(arrayRes.status).toBe(400);
    expect(arrayRes.body).toEqual({ code: 'VERSE_INVALID', error: 'body must be a JSON object' });

    const nullRes = makeRes();
    expect(await readMutationBody(ctx, makeReq({ ...headers, body: 'null' }), nullRes.res)).toBeNull();
    expect(nullRes.status).toBe(400);
    expect(nullRes.body).toEqual({ code: 'VERSE_INVALID', error: 'body must be a JSON object' });

    const extraKeyRes = makeRes();
    const longUnknown = 'z'.repeat(70);
    expect(
      await readMutationBody(
        ctx,
        makeReq({ ...headers, body: JSON.stringify({ ok: true, [longUnknown]: 1 }) }),
        extraKeyRes.res,
        { allowedKeys: ['ok'] },
      ),
    ).toBeNull();
    expect(extraKeyRes.status).toBe(400);
    expect(extraKeyRes.body).toEqual({
      code: 'VERSE_INVALID',
      error: `unknown key: ${'z'.repeat(64)}`,
    });

    const validRes = makeRes();
    expect(
      await readMutationBody(
        ctx,
        makeReq({ ...headers, body: '{"ok":true}' }),
        validRes.res,
        { allowedKeys: ['ok'] },
      ),
    ).toEqual({ ok: true });
  });
});
