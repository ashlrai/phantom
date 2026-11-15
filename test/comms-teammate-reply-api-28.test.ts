/** POST /api/verse/comms/teammate-reply: reply to an unanswered teammate text. Fake ids, injected seams. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { createCommsTeammateReplyApi, VERSE_COMMS_TEAMMATE_REPLY_PATH as PATH } from '../src/core/verse/comms-teammate-reply-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 't'.repeat(64);
const row: TeammateText = { at: '2026-11-09T10:00:00.000Z', rowid: 7, senderId: 'imessage:teammate-fake-1', text: 'can you check?', ageMinutes: 3 };

function setup(outcome: 'accepted' | 'uncertain' | 'refused' = 'accepted') {
  const send = vi.fn(async (_t: string, _s: string, _c: unknown) => outcome);
  const mark = vi.fn((_ids: number[], _dir: string) => 1);
  const read = vi.fn((_dir: string) => [row]);
  const api = createCommsTeammateReplyApi({ runsDir: '/tmp/fake-runs', read, send, mark, loadConfig: () => ({}) });
  return { api, send, mark, read };
}

async function call(api: ReturnType<typeof createCommsTeammateReplyApi>, body: unknown, opts: { method?: string; allowDispatch?: boolean } = {}) {
  const method = opts.method ?? 'POST';
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), {
    url: PATH, method, headers: { 'x-ashlr-token': TOKEN, 'content-type': 'application/json', host: 'localhost' },
  }) as unknown as IncomingMessage;
  req.end(typeof body === 'string' ? body : JSON.stringify(body));
  const res = { writeHead(code: number) { status = code; return this; }, setHeader() {}, end(b: string) { text = b; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: opts.allowDispatch ?? true, token: TOKEN } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('POST /api/verse/comms/teammate-reply', () => {
  it('does not claim other paths', async () => {
    const { api } = setup();
    let status = 0;
    const res = { writeHead(c: number) { status = c; return this; }, end() {} } as unknown as ServerResponse;
    expect(await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as unknown as IncomingMessage, res, '/api/verse/comms/inbox', 'POST')).toBe(false);
    expect(status).toBe(0);
  });

  it('405 on GET', async () => {
    const { api, send } = setup();
    expect((await call(api, {}, { method: 'GET' })).status).toBe(405);
    expect(send).not.toHaveBeenCalled();
  });

  it('404 when dispatch is disabled', async () => {
    const { api, send } = setup();
    expect((await call(api, { rowid: 7, text: 'hi' }, { allowDispatch: false })).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', 'nope'],
    ['array', []],
    ['missing text', { rowid: 7 }],
    ['non-integer rowid', { rowid: 7.5, text: 'hi' }],
    ['string rowid', { rowid: '7', text: 'hi' }],
    ['zero rowid', { rowid: 0, text: 'hi' }],
    ['empty text', { rowid: 7, text: '   ' }],
    ['long text', { rowid: 7, text: 'x'.repeat(4001) }],
    ['extra to', { rowid: 7, text: 'hi', to: 'teammate-fake-2' }],
    ['extra handle', { rowid: 7, text: 'hi', handle: 'teammate-fake-2' }],
  ])('400 on %s', async (_name, body) => {
    const { api, send, mark } = setup();
    expect((await call(api, body)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it('accepts exactly 4000 characters', async () => {
    const { api } = setup();
    expect((await call(api, { rowid: 7, text: 'x'.repeat(4000) })).status).toBe(200);
  });

  it('404 unknown for a rowid that is not unanswered', async () => {
    const { api, send, mark } = setup();
    const r = await call(api, { rowid: 99, text: 'hi' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ v: 1, status: 'unknown' });
    expect(send).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it('refused -> 403, nothing marked', async () => {
    const { api, mark } = setup('refused');
    const r = await call(api, { rowid: 7, text: 'hi' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ v: 1, status: 'refused' });
    expect(mark).not.toHaveBeenCalled();
  });

  it('uncertain -> 202, nothing marked', async () => {
    const { api, mark } = setup('uncertain');
    const r = await call(api, { rowid: 7, text: 'hi' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ v: 1, status: 'uncertain' });
    expect(mark).not.toHaveBeenCalled();
  });

  it('accepted -> 200, marks once, sends to the stored senderId', async () => {
    const { api, send, mark } = setup('accepted');
    const r = await call(api, { rowid: 7, text: 'on it' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, status: 'sent', rowid: 7 });
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls[0]?.[0]).toEqual([7]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('on it');
    expect(send.mock.calls[0]?.[1]).toBe('imessage:teammate-fake-1');
  });

  it('refuses without sending when config cannot load', async () => {
    const send = vi.fn(async () => 'accepted' as const);
    const api = createCommsTeammateReplyApi({ runsDir: '/tmp/fake-runs', read: () => [row], send, mark: () => 1, loadConfig: () => { throw new Error('bad'); } });
    expect((await call(api, { rowid: 7, text: 'hi' })).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});
