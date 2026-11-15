/** RQ-PHX-RECUTCOMMSC174: recut of #5054 — the teammate reply-age read
 * (GET /api/verse/comms/teammate-reply-age) mounted on the real
 * comms-teammate-reply route family, exercised through its exported entry
 * points. Fake rows only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createCommsTeammateReplyAgeApi,
  handleCommsTeammateReplyAgeApi,
  teammateReplyAge,
  VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH as PATH,
} from '../src/core/verse/comms-teammate-reply-age-api.js';
import {
  handleCommsTeammateReplyApi,
  VERSE_COMMS_TEAMMATE_REPLY_PATH,
} from '../src/core/verse/comms-teammate-reply-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

async function call(api: ReturnType<typeof createCommsTeammateReplyAgeApi>, method = 'GET', path = PATH, allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('comms teammate reply age (recut of #5054)', () => {
  it('teammateReplyAge marks the newest text answered only by its own marker', () => {
    const rows = [
      { v: 1, at: iso(NOW - 10 * 60_000), rowid: 7, senderId: 'fake-sender', text: 'fake first' },
      { v: 1, answered: 7, at: iso(NOW - 9 * 60_000) },
      { v: 1, at: iso(NOW - 2 * 60_000), rowid: 8, senderId: 'fake-sender', text: 'fake second' },
    ];
    // The marker answers rowid 7, not the newest rowid 8.
    expect(teammateReplyAge(rows)).toEqual({ lastInboundAt: iso(NOW - 2 * 60_000), lastOutboundAt: null, answered: false });
    expect(teammateReplyAge([...rows, { v: 1, answered: 8, at: iso(NOW - 60_000) }])).toEqual({
      lastInboundAt: iso(NOW - 2 * 60_000), lastOutboundAt: iso(NOW - 60_000), answered: true,
    });
    expect(teammateReplyAge([])).toEqual({ lastInboundAt: null, lastOutboundAt: null, answered: null });
  });

  it('serves the read over the injected reader seam, times and flags only', async () => {
    const api = createCommsTeammateReplyAgeApi({
      read: () => ({
        state: 'healthy',
        rows: [
          { v: 1, at: iso(NOW - 4 * 60_000), rowid: 3, senderId: 'fake-sender', text: 'fake text' },
          { v: 1, answered: 3, at: iso(NOW - 60_000) },
        ],
      }),
    });
    const r = await call(api);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 60_000), answered: true,
    });
    // The response never carries message text or sender ids.
    expect(JSON.stringify(r.body)).not.toContain('fake text');
    expect(JSON.stringify(r.body)).not.toContain('fake-sender');
  });

  it('stays read-only and gated: wrong path, POST and no dispatch are refused', async () => {
    const api = createCommsTeammateReplyAgeApi({ read: () => ({ rows: [], state: 'missing' }) });
    expect((await call(api, 'GET', '/api/verse/other')).handled).toBe(false);
    expect((await call(api, 'POST')).status).toBe(405);
    expect((await call(api, 'GET', PATH, false)).status).toBe(404);
    const missing = await call(api);
    expect(missing.body).toMatchObject({ schema: 'comms.teammate-reply-age.v1', source: 'missing', answered: null });
  });

  it('is claimed by the real comms-teammate-reply route family', () => {
    const family = workbenchFamilyFor(PATH);
    expect(family?.id).toBe('comms-teammate-reply');
    expect(family?.handler).toBe('handleCommsTeammateReplyApi');
    // Segment boundary: the reply POST path still resolves to the same family.
    expect(workbenchFamilyFor(VERSE_COMMS_TEAMMATE_REPLY_PATH)?.id).toBe('comms-teammate-reply');
  });

  it('the mounted family handler answers the age read and still serves the reply POST', async () => {
    const age = await call(handleCommsTeammateReplyApi);
    expect(age.handled).toBe(true);
    expect(age.status).toBe(200);
    // No teammates store under the test HOME reads as 'missing', never a crash.
    expect(age.body).toMatchObject({ schema: 'comms.teammate-reply-age.v1', answered: null });
    const replyGet = await call(handleCommsTeammateReplyApi, 'GET', VERSE_COMMS_TEAMMATE_REPLY_PATH);
    expect(replyGet.handled).toBe(true);
    expect(replyGet.status).toBe(405);
    expect(handleCommsTeammateReplyAgeApi).toBeTypeOf('function');
  });
});
