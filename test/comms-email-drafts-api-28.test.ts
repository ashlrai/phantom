/** Email draft review routes under /api/verse/comms/inbox/email-drafts. Real drafts.ts store in a temp dir, fake addresses. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDraft, getDraft } from '../src/core/cos/drafts.js';
import { createCommsInboxApi, VERSE_COMMS_INBOX_PATH } from '../src/core/verse/comms-inbox-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const BASE = `${VERSE_COMMS_INBOX_PATH}/email-drafts`;
const TOKEN = 'a'.repeat(64);
let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'email-drafts-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

async function call(path: string, method = 'GET', body?: unknown, allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), {
    url: path, method, headers: { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  if (body !== undefined) req.push(typeof body === 'string' ? body : JSON.stringify(body));
  req.push(null);
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk: string) { text = chunk; }, setHeader() {} } as unknown as ServerResponse;
  const api = createCommsInboxApi({ runsDir, now: () => 1_700_000_000_000 });
  const handled = await api({ cfg: {}, allowDispatch, token: TOKEN } as VerseApiContext, req, res, path.split('?')[0]!, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const make = (n: number, body = `Hello ${n}`, at = n) =>
  createDraft({ to: `someone${n}@example.invalid`, subject: `Subject ${n}`, body, source: `outbox-${n}.eml` }, runsDir, () => new Date(Date.UTC(2026, 10, at)));

describe('GET email-drafts', () => {
  it('lists only pending, newest first', async () => {
    const a = await make(1), b = await make(2), c = await make(3);
    await call(`${BASE}/reject`, 'POST', { id: b.id });
    const r = await call(BASE);
    expect(r.status).toBe(200);
    expect(r.body.v).toBe(1);
    expect(r.body.drafts.map((d: { id: string }) => d.id)).toEqual([c.id, a.id]);
    expect(r.body.drafts[0]).toMatchObject({ to: 'someone3@example.invalid', subject: 'Subject 3', body: 'Hello 3', digest: `sha256:${c.digest}` });
    expect(r.body.drafts[0].truncated).toBeUndefined();
  });

  it('caps at 50 rows and truncates long bodies', async () => {
    const long = await make(1, 'x'.repeat(9000));
    const r = await call(BASE);
    expect(r.body.drafts[0].body).toHaveLength(8000);
    expect(r.body.drafts[0].truncated).toBe(true);
    expect(r.body.drafts[0].digest).toBe(`sha256:${long.digest}`);
    for (let i = 2; i <= 52; i++) await make(i, `b${i}`, 1 + (i % 28));
    expect((await call(BASE)).body.drafts).toHaveLength(50);
  });

  it('is 404 without allowDispatch and 405 for a wrong method', async () => {
    expect((await call(BASE, 'GET', undefined, false)).status).toBe(404);
    expect((await call(BASE, 'POST', {})).status).toBe(405);
    expect((await call(`${BASE}/approve`, 'GET')).status).toBe(405);
  });
});

describe('POST approve and reject', () => {
  it('approves with the full digest, records it, and a second approve is already-decided', async () => {
    const d = await make(1);
    const r = await call(`${BASE}/approve`, 'POST', { id: d.id, digest: `sha256:${d.digest}` });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, status: 'approved', id: d.id });
    expect((await getDraft(d.id, runsDir))?.status).toBe('approved');
    const again = await call(`${BASE}/approve`, 'POST', { id: d.id, digest: d.digest });
    expect(again.status).toBe(409);
    expect(again.body.status).toBe('already-decided');
  });

  it('accepts the bare 64-hex digest too', async () => {
    const d = await make(1);
    expect((await call(`${BASE}/approve`, 'POST', { id: d.id, digest: d.digest })).status).toBe(200);
  });

  it('a wrong digest is stale and leaves the draft pending', async () => {
    const d = await make(1);
    const r = await call(`${BASE}/approve`, 'POST', { id: d.id, digest: 'f'.repeat(64) });
    expect(r.status).toBe(409);
    expect(r.body.status).toBe('stale');
    expect((await getDraft(d.id, runsDir))?.status).toBe('pending');
  });

  it('a digest prefix is a 400', async () => {
    const d = await make(1);
    expect((await call(`${BASE}/approve`, 'POST', { id: d.id, digest: d.digest.slice(0, 16) })).status).toBe(400);
  });

  it('rejects, and rejecting twice is already-decided', async () => {
    const d = await make(1);
    const r = await call(`${BASE}/reject`, 'POST', { id: d.id });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, status: 'rejected', id: d.id });
    expect((await getDraft(d.id, runsDir))?.status).toBe('rejected');
    expect((await call(`${BASE}/reject`, 'POST', { id: d.id })).status).toBe(409);
  });

  it('unknown id is 404', async () => {
    expect((await call(`${BASE}/reject`, 'POST', { id: 'd-0123456789abcdef' })).status).toBe(404);
    expect((await call(`${BASE}/approve`, 'POST', { id: 'd-0123456789abcdef', digest: 'a'.repeat(64) })).status).toBe(404);
  });

  it('bad id shape, extra key, bad JSON are 400', async () => {
    const d = await make(1);
    expect((await call(`${BASE}/reject`, 'POST', { id: '../x' })).status).toBe(400);
    expect((await call(`${BASE}/reject`, 'POST', { id: d.id, extra: 1 })).status).toBe(400);
    expect((await call(`${BASE}/reject`, 'POST', { id: d.id, digest: d.digest })).status).toBe(400);
    expect((await call(`${BASE}/reject`, 'POST', '{nope')).status).toBe(400);
    expect((await getDraft(d.id, runsDir))?.status).toBe('pending');
  });

  it('is 404 without allowDispatch', async () => {
    const d = await make(1);
    expect((await call(`${BASE}/reject`, 'POST', { id: d.id }, false)).status).toBe(404);
    expect((await getDraft(d.id, runsDir))?.status).toBe('pending');
  });

  it('a store failure is 503 without echoing the error', async () => {
    let status = 0, text = '';
    const req = Object.assign(new PassThrough(), { url: BASE, method: 'GET', headers: {} }) as unknown as IncomingMessage;
    const res = { writeHead(c: number) { status = c; return this; }, end(t: string) { text = t; }, setHeader() {} } as unknown as ServerResponse;
    const failing = createCommsInboxApi({ runsDir, listDrafts: async () => { throw new Error('secret-path /tmp/x'); } });
    await failing({ cfg: {}, allowDispatch: true, token: TOKEN } as VerseApiContext, req, res, BASE, 'GET');
    expect(status).toBe(503);
    expect(text).not.toContain('secret-path');
  });
});

describe('exact inbox path', () => {
  it('still 405s non-GET and ignores unknown subpaths', async () => {
    expect((await call(VERSE_COMMS_INBOX_PATH, 'POST', {})).status).toBe(405);
    expect((await call(`${VERSE_COMMS_INBOX_PATH}/other`)).handled).toBe(false);
  });
});
