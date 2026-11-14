/** GET /api/verse/comms/teammate-reply-age: the desktop read of the newest
 * teammate (Dot) text and its answer state. Fake rowids/senders only. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommsTeammateReplyAgeApi, teammateReplyAge, VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH as PATH } from '../src/core/verse/comms-teammate-reply-age-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let runsDir: string;
let imessageDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'teammate-reply-age-'));
  imessageDir = join(runsDir, 'imessage');
  mkdirSync(imessageDir, { recursive: true });
});
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

function writeRows(rows: Record<string, unknown>[]): void {
  writeFileSync(join(imessageDir, 'teammates.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
}

async function call(method = 'GET', allowDispatch = true, path = PATH) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createCommsTeammateReplyAgeApi({ runsDir });
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('GET /api/verse/comms/teammate-reply-age', () => {
  it('answers the newest inbound text and its answer time', async () => {
    writeRows([
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'teammate-test-1', text: 'fake older text' },
      { v: 1, answered: 40, at: iso(NOW - 25 * 60_000) },
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake newer text' },
      { v: 1, answered: 41, at: iso(NOW - 1 * 60_000) },
    ]);
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'comms.teammate-reply-age.v1', source: 'healthy', lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 1 * 60_000), answered: true });
  });

  it('reports the newest text as unanswered with a null outbound time', async () => {
    writeRows([
      { v: 1, at: iso(NOW - 30 * 60_000), rowid: 40, senderId: 'teammate-test-1', text: 'fake older text' },
      { v: 1, answered: 40, at: iso(NOW - 25 * 60_000) },
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake newer text' },
    ]);
    const r = await call();
    expect(r.body).toEqual({ schema: 'comms.teammate-reply-age.v1', source: 'healthy', lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: null, answered: false });
  });

  it('says missing when there is no teammates file', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'comms.teammate-reply-age.v1', source: 'missing', lastInboundAt: null, lastOutboundAt: null, answered: null });
  });

  it('never returns message text or sender ids', async () => {
    writeRows([
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-1', text: 'fake secret body' },
    ]);
    const r = await call();
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('fake secret body');
    expect(raw).not.toContain('teammate-test-1');
    expect(Object.keys(r.body).sort()).toEqual(['answered', 'lastInboundAt', 'lastOutboundAt', 'schema', 'source']);
  });

  it('POST is a 405, no dispatch is a 404, other paths pass through', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('GET', false)).status).toBe(404);
    expect((await call('GET', true, '/api/verse/comms/other')).handled).toBe(false);
  });

  it('a reader failure says unavailable, not a faked time', async () => {
    const api = createCommsTeammateReplyAgeApi({ read: () => { throw new Error('nope'); } });
    let status = 0, text = '';
    const req = Object.assign(new PassThrough(), { url: PATH, method: 'GET' }) as IncomingMessage;
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ source: 'unavailable', lastInboundAt: null, lastOutboundAt: null, answered: null });
  });
});

describe('teammateReplyAge', () => {
  it('ignores malformed rows and markers for other rowids', () => {
    const view = teammateReplyAge([
      { v: 1, answered: 99, at: iso(NOW) },
      { v: 1, at: 'not-a-time', rowid: 98, senderId: 'teammate-test-1', text: 'bad at' },
      { v: 1, at: iso(NOW - 10 * 60_000), rowid: 50, senderId: 'teammate-test-1', text: 'fake' },
    ]);
    expect(view).toEqual({ lastInboundAt: iso(NOW - 10 * 60_000), lastOutboundAt: null, answered: false });
  });
});
