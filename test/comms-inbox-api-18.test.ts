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
    expect(Object.keys(r.body.sources).sort()).toEqual(['board', 'bus', 'conversations', 'drafts', 'email-inbox', 'email-outbox', 'gmail', 'imessage', 'leader-delivery', 'linkedin', 'mailbox', 'needs-you', 'needs-you-delivery', 'org-outbox', 'owner-delivery', 'owner-thread', 'peer-dispatch', 'proposals', 'requests', 'seats', 'slack', 'slack-sends', 'team-approvals', 'teammate-tasks', 'wakes']);
  });

  it('forwards the view filter to the reader and echoes the applied filter', async () => {
    let seen: { filter?: unknown } | undefined;
    const r = await call({
      read: async (options) => {
        seen = options;
        // The real readUnifiedInbox echoes the normalized filter on its report.
        return { ...inbox(2), ...(options.filter === undefined ? {} : { filter: options.filter }) };
      },
    }, 'GET', '?source=bus&kind=bus-work&severity=warn&blocking=true&job=RQ-1&since=1h&before=30m&contains=parser');
    expect(r.status).toBe(200);
    expect(seen?.filter).toEqual({
      source: 'bus', kind: 'bus-work', severity: 'warn', blocking: true,
      job: 'RQ-1', since: NOW - 3_600_000, before: NOW - 1_800_000, contains: 'parser',
    });
    expect(r.body.filter).toEqual(seen?.filter);
  });

  it('blocking=false narrows to non-blocking items', async () => {
    let seen: { filter?: { blocking?: boolean } } | undefined;
    const r = await call({
      read: async (options) => { seen = options; return inbox(1); },
    }, 'GET', '?blocking=false');
    expect(r.status).toBe(200);
    expect(seen?.filter).toEqual({ blocking: false });
    expect(r.body.filter).toBeUndefined();
  });

  it('an unfiltered read passes no filter and echoes none', async () => {
    let seen: { filter?: unknown } | undefined;
    const r = await call({
      read: async (options) => { seen = options; return inbox(1); },
    });
    expect(r.status).toBe(200);
    expect(seen?.filter).toBeUndefined();
    expect(r.body.filter).toBeUndefined();
  });

  it('since accepts epoch ms and ISO times like every other bus read', async () => {
    let seen: { filter?: { since?: number } } | undefined;
    const r = await call({
      read: async (options) => { seen = options; return inbox(0); },
    }, 'GET', `?since=${NOW}`);
    expect(r.status).toBe(200);
    expect(seen?.filter?.since).toBe(NOW);
  });

  it('before takes the same epoch ms and ISO grammar as since', async () => {
    let seen: { filter?: { before?: number } } | undefined;
    const r = await call({
      read: async (options) => { seen = options; return inbox(0); },
    }, 'GET', `?before=${NOW}`);
    expect(r.status).toBe(200);
    expect(seen?.filter?.before).toBe(NOW);
    const iso = await call({
      read: async (options) => { seen = options; return inbox(0); },
    }, 'GET', '?before=2026-11-07T11:30:00Z');
    expect(iso.status).toBe(200);
    expect(seen?.filter?.before).toBe(Date.parse('2026-11-07T11:30:00Z'));
  });

  it.each([
    '?source=bogus', '?kind=bogus', '?severity=critical', '?blocking=yes', '?blocking=',
    '?job=a%20b', '?since=not-a-time', '?before=not-a-time', '?before=',
    '?contains=', '?contains=%20%20',
    `?contains=${'x'.repeat(513)}`, '?unknown=1', '?source=bus&source=imessage',
    '?limit=0', '?limit=201', '?limit=1.5',
  ])('%s is a 400', async (query) => {
    const r = await call({ read: async () => inbox(1) }, 'GET', query);
    expect(r.status).toBe(400);
  });
});
