import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createCosMemoryApi } from '../src/core/verse/cos-memory-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';

const TOKEN = 'cos-memory-test-token';
const BASE = '/api/verse/cos/memory';
const FORGET = `${BASE}/forget`;
let home = '';

async function call(api: ReturnType<typeof createCosMemoryApi>, o: { path: string; method?: string; body?: unknown; token?: string | null; allowDispatch?: boolean }) {
  const method = o.method ?? 'POST';
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(o.body ?? {})]) as unknown as IncomingMessage;
  req.url = o.path;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...(o.token === null ? {} : { 'x-ashlr-token': o.token ?? TOKEN }) };
  let status = 0;
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    setHeader() {},
    end(text: string) { raw = text ?? ''; },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: o.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, o.path.split('?')[0]!, method);
  let wire: Record<string, any> | null = null;
  try { wire = JSON.parse(raw); } catch { /* empty body */ }
  return { handled, status, raw, wire };
}
const make = () => createCosMemoryApi({ home, now: () => new Date('2026-11-01T12:00:00Z') });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cos-memory-api-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('cos memory api', () => {
  it('is registered in the workbench family table', () => {
    expect(workbenchFamilyFor(FORGET)?.id).toBe('cos-memory');
  });

  it('adds then lists with source desktop', async () => {
    const api = make();
    const added = await call(api, { path: BASE, body: { kind: 'preference', text: 'prefers short plain replies' } });
    expect(added.status).toBe(201);
    expect(added.wire?.entry).toMatchObject({ kind: 'preference', source: 'desktop', text: 'prefers short plain replies', updated: '2026-11-01T12:00:00.000Z' });
    const listed = await call(api, { path: BASE, method: 'GET' });
    expect(listed.status).toBe(200);
    expect(listed.wire).toEqual({ v: 1, entries: [added.wire?.entry] });
  });

  it('filters by kind and rejects an unknown kind', async () => {
    const api = make();
    await call(api, { path: BASE, body: { kind: 'preference', text: 'plain preference' } });
    await call(api, { path: BASE, body: { kind: 'fact', text: 'plain fact' } });
    const facts = await call(api, { path: `${BASE}?kind=fact`, method: 'GET' });
    expect(facts.wire?.entries.map((e: { kind: string }) => e.kind)).toEqual(['fact']);
    const bad = await call(api, { path: `${BASE}?kind=mood`, method: 'GET' });
    expect(bad.status).toBe(400);
    expect(bad.wire?.code).toBe('VERSE_INVALID');
  });

  it('forgets once, then reports nothing removed', async () => {
    const api = make();
    const id = (await call(api, { path: BASE, body: { kind: 'doctrine', text: 'plain doctrine' } })).wire?.entry.id;
    expect((await call(api, { path: FORGET, body: { id } })).wire).toEqual({ v: 1, removed: true });
    expect((await call(api, { path: FORGET, body: { id } })).wire).toEqual({ v: 1, removed: false });
    expect((await call(api, { path: FORGET, body: { id: 'Bad Id' } })).status).toBe(400);
  });

  it('rejects extra or missing body keys', async () => {
    const api = make();
    expect((await call(api, { path: BASE, body: { kind: 'fact', text: 'x', extra: 'y' } })).status).toBe(400);
    expect((await call(api, { path: BASE, body: { kind: 'fact' } })).status).toBe(400);
    expect((await call(api, { path: FORGET, body: { id: 'fact-1', extra: 1 } })).status).toBe(400);
  });

  it('refuses secret-shaped text without echoing it', async () => {
    const secret = `ghp_${'A'.repeat(36)}`;
    const r = await call(make(), { path: BASE, body: { kind: 'fact', text: `token ${secret}` } });
    expect(r.status).toBe(422);
    expect(r.wire?.code).toBe('MEMORY_REFUSED');
    expect(r.raw).not.toContain(secret);
    expect(r.raw).not.toContain('AAAA');
  });

  it('refuses a POST without the mutation token', async () => {
    const api = make();
    const r = await call(api, { path: BASE, body: { kind: 'fact', text: 'plain fact' }, token: 'wrong' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).not.toBe(422);
    expect((await call(api, { path: FORGET, body: { id: 'fact-1' }, token: null })).status).toBeGreaterThanOrEqual(400);
    expect((await call(api, { path: BASE, method: 'GET' })).wire?.entries).toEqual([]);
  });

  it('404s when dispatch is disallowed, 405s wrong methods, ignores other paths', async () => {
    const api = make();
    expect((await call(api, { path: BASE, method: 'GET', allowDispatch: false })).status).toBe(404);
    expect((await call(api, { path: FORGET, allowDispatch: false })).status).toBe(404);
    expect((await call(api, { path: BASE, method: 'DELETE' })).status).toBe(405);
    expect((await call(api, { path: FORGET, method: 'GET' })).status).toBe(405);
    expect((await call(api, { path: '/api/verse/cos/other', method: 'GET' })).handled).toBe(false);
  });
});
