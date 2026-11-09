/** POST /api/verse/comms/inbox/linkedin/answered. Fake ids, no real runs dir. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createCommsInboxApi, VERSE_COMMS_INBOX_PATH } from '../src/core/verse/comms-inbox-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = `${VERSE_COMMS_INBOX_PATH}/linkedin/answered`;
const TOKEN = 'a'.repeat(64);

async function call(markLinkedIn: ReturnType<typeof vi.fn>, method: string, body?: unknown, opts: { token?: string; allowDispatch?: boolean } = {}) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), {
    url: PATH, method,
    headers: { 'x-ashlr-token': opts.token ?? TOKEN, 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  if (body !== undefined) req.push(typeof body === 'string' ? body : JSON.stringify(body));
  req.push(null);
  const res = { writeHead(code: number) { status = code; return this; }, end(b: string) { text = b; } } as unknown as ServerResponse;
  const api = createCommsInboxApi({ runsDir: '/nonexistent-fake-runs', markLinkedIn: markLinkedIn as never });
  const handled = await api({ cfg: {}, allowDispatch: opts.allowDispatch ?? true, token: TOKEN } as unknown as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('POST linkedin/answered', () => {
  it('marks through the seam with the fixed runs dir', async () => {
    const seam = vi.fn(() => 'marked');
    const r = await call(seam, 'POST', { id: 'fake-msg-1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'marked' });
    expect(seam).toHaveBeenCalledWith('/nonexistent-fake-runs', 'fake-msg-1');
  });

  it('reports already', async () => {
    const r = await call(vi.fn(() => 'already'), 'POST', { id: 'fake-msg-1' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('already');
  });

  it.each([{ id: '../x' }, { id: '' }, { id: 5 }, {}, { id: 'a', path: '/etc' }, [], 'not json'])('400 for %j', async body => {
    const seam = vi.fn(() => 'invalid');
    const r = await call(seam, 'POST', body);
    expect(r.status).toBe(400);
    expect(seam).not.toHaveBeenCalledWith(expect.anything(), '/etc');
  });

  it('401 without the token and never marks', async () => {
    const seam = vi.fn(() => 'marked');
    const r = await call(seam, 'POST', { id: 'fake-msg-1' }, { token: 'b'.repeat(64) });
    expect(r.status).toBe(401);
    expect(seam).not.toHaveBeenCalled();
  });

  it('404 when dispatch is not allowed', async () => {
    const seam = vi.fn(() => 'marked');
    expect((await call(seam, 'POST', { id: 'fake-msg-1' }, { allowDispatch: false })).status).toBe(404);
    expect(seam).not.toHaveBeenCalled();
  });

  it('GET is not a mark', async () => {
    const seam = vi.fn(() => 'marked');
    const r = await call(seam, 'GET');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(405);
    expect(seam).not.toHaveBeenCalled();
  });

  it('503 when the write fails', async () => {
    const r = await call(vi.fn(() => { throw new Error('disk'); }), 'POST', { id: 'fake-msg-1' });
    expect(r.status).toBe(503);
  });
});
