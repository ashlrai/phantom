/** GET /api/verse/comms/inbox: the desktop read of the unified comms inbox. Synthetic ids, temp dirs. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UnifiedInbox, UnifiedInboxItem } from '../src/core/comms/unified-inbox.js';
import { createCommsInboxApi, VERSE_COMMS_INBOX_PATH as PATH, type CommsInboxApiDeps } from '../src/core/verse/comms-inbox-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = 1_700_000_000_000;
const item = (n: number): UnifiedInboxItem => ({
  id: `imessage:teammate-${n}`, source: 'imessage', kind: 'teammate-text', severity: 'info', priority: 'normal' as UnifiedInboxItem['priority'],
  blocking: false, title: `fake text ${n}`, detail: `teammate-sender-${n} · waiting ${n}m`, since: null, expiresAt: null, act: [],
} as UnifiedInboxItem);
const source = { state: 'healthy' as const, pending: 0 };
const inbox = (count: number): UnifiedInbox => ({
  v: 1, generatedAt: new Date(NOW).toISOString(), total: count, omitted: 0,
  sources: { 'needs-you': source, imessage: { state: 'healthy', pending: count }, drafts: source, bus: source },
  items: Array.from({ length: count }, (_, i) => item(i + 1)),
});

let runsDir: string;
let busRoot: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'comms-inbox-api-'));
  busRoot = mkdtempSync(join(tmpdir(), 'comms-inbox-bus-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

async function call(deps: CommsInboxApiDeps, method = 'GET', query = '', allowDispatch = true) {
  const url = PATH + query;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createCommsInboxApi({ runsDir, busRoot, now: () => NOW, ...deps });
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('GET /api/verse/comms/inbox', () => {
  it('returns the schema and items', async () => {
    const r = await call({ read: async () => inbox(3) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'comms.unified-inbox.v1', total: 3, omitted: 0 });
    expect(r.body.items.map((i: UnifiedInboxItem) => i.id)).toEqual(['imessage:teammate-1', 'imessage:teammate-2', 'imessage:teammate-3']);
    expect(r.body.sources.imessage.pending).toBe(3);
  });

  it('limit slices the items and recomputes omitted', async () => {
    const r = await call({ read: async () => inbox(5) }, 'GET', '?limit=2');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.omitted).toBe(3);
  });

  it('passes the injected dirs and clock to the reader', async () => {
    let seen: unknown;
    await call({ read: async (o) => { seen = o; return inbox(0); } });
    expect(seen).toMatchObject({ runsDir, busRoot, now: expect.any(Function) });
  });

  it.each(['0', 'abc', '500', '-1', '1.5', ''])('limit=%s is a 400', async (value) => {
    const r = await call({ read: async () => inbox(1) }, 'GET', `?limit=${value}`);
    expect(r.status).toBe(400);
  });

  it('POST is a 405', async () => {
    expect((await call({ read: async () => inbox(1) }, 'POST')).status).toBe(405);
  });

  it('allowDispatch false is a 404', async () => {
    expect((await call({ read: async () => inbox(1) }, 'GET', '', false)).status).toBe(404);
  });

  it('other paths are not handled', async () => {
    const api = createCommsInboxApi();
    expect(await api({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, {} as ServerResponse, '/api/verse/other', 'GET')).toBe(false);
  });

  it('a throwing reader answers 200 unavailable', async () => {
    const r = await call({ read: async () => { throw new Error('boom'); } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'comms.unified-inbox.v1', unavailable: true, items: [] });
  });

  it('the real reader on empty temp dirs gives a well-formed empty answer', async () => {
    const r = await call({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'comms.unified-inbox.v1', total: 0, omitted: 0, items: [] });
    expect(Object.keys(r.body.sources).sort()).toEqual(['bus', 'drafts', 'imessage', 'needs-you']);
  });
});
