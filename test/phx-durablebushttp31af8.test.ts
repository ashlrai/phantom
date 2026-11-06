import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, inspectBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import { handleVerseApi, setWorkbenchApiModulesForTest, workbenchApiModules, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';

const path = '/api/verse/agent-bus';
const token = 'fake-mutation-token';
const message = (id: string, ttl = 100) => ({ id, from: 'fake-sender', to: 'fake-recipient', priority: 'P2', ttl, body: { text: 'fake message' } });
const roots: string[] = [];
afterEach(() => {
  setWorkbenchApiModulesForTest(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fake-bus-http-'));
  roots.push(root);
  let now = 100;
  const options = { root, now: () => now };
  const append = vi.fn((input: unknown) => appendBusInbox(input, options));
  const handler = createAgentBusApi({ append, list: (after, limit) => listBusInboxAfter(after, limit, options), inspect: () => inspectBusInbox(options) });
  setWorkbenchApiModulesForTest([{ id: 'agent-bus', load: async () => handler }]);
  return { root, append, advance: (value: number) => { now = value; } };
}
async function request(url: string, opts: { method?: string; body?: string; token?: string; dispatch?: boolean; session?: boolean } = {}) {
  const method = opts.method ?? 'GET';
  const req = Readable.from(opts.body === undefined ? [] : [opts.body]) as unknown as IncomingMessage;
  req.url = url; req.method = method;
  req.headers = { 'content-type': 'application/json', ...(opts.token === undefined ? {} : { 'x-ashlr-token': opts.token }) };
  let status = 0, wire: Record<string, unknown> = {};
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; } } as unknown as ServerResponse;
  const ctx = { cfg: {}, token, allowDispatch: opts.dispatch ?? true,
    ...(opts.session === false ? {} : { readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } }) } as VerseApiContext;
  const handled = await handleVerseApi(ctx, req, res, url.split('?')[0]!, method);
  return { handled, status, wire };
}
const post = (body: unknown) => request(path, { method: 'POST', token, body: JSON.stringify(body) });

describe('durable bus HTTP family', () => {
  it('registers one family and resolves the real handler', async () => {
    expect(workbenchFamilyFor(path)?.id).toBe('agent-bus');
    expect(workbenchFamilyFor(`${path}/status`)?.id).toBe('agent-bus');
    expect(workbenchFamilyFor(`${path}other`)).toBeNull();
    expect(typeof await workbenchApiModules().find(entry => entry.id === 'agent-bus')!.load()).toBe('function');
  });
  it('posts, reads and inspects the same isolated store, including duplicates and conflicts', async () => {
    const { root } = setup();
    expect(await request(`${path}/status`)).toMatchObject({ status: 200, wire: { v: 1, source: 'missing', retainedCount: null } });
    expect(await post(message('fake-one'))).toMatchObject({ status: 201, wire: { v: 1, status: 'posted', cursor: 1 } });
    expect(await post(message('fake-one'))).toMatchObject({ status: 200, wire: { status: 'duplicate', cursor: 1 } });
    expect(await post({ ...message('fake-one'), body: 'fake conflict' })).toMatchObject({ status: 409, wire: { status: 'conflict' } });
    expect(await request(`${path}?after=0&limit=1`)).toMatchObject({ status: 200, wire: { v: 1, status: 'ok', nextCursor: 1, messages: [{ envelope: message('fake-one') }] } });
    expect(listBusInboxAfter(0, 50, { root, now: () => 100 })).toMatchObject({ messages: [{ envelope: message('fake-one') }] });
    expect(await request(`${path}/status`)).toMatchObject({ status: 200, wire: { source: 'available', retainedCount: 1, liveCount: 1 } });
  });
  it('advances cursors through expired messages without resurrecting them', async () => {
    const store = setup();
    await post(message('fake-expired', 10));
    await post(message('fake-live', 100));
    store.advance(110);
    expect(await request(`${path}?limit=1`)).toMatchObject({ wire: { nextCursor: 2, messages: [{ cursor: 2, envelope: { id: 'fake-live', ttl: 90 } }] } });
    store.advance(201);
    expect(await request(`${path}?after=0`)).toMatchObject({ wire: { nextCursor: 2, messages: [] } });
    expect(await request(`${path}?after=2`)).toMatchObject({ wire: { nextCursor: 2, messages: [] } });
  });
  it('rejects malformed queries, bodies and extra routes before append', async () => {
    const { append } = setup();
    for (const query of ['?after=-1', '?after=01', '?after=9007199254740992', '?limit=0', '?limit=101', '?limit=1&limit=2', '?root=fake']) {
      expect((await request(path + query)).status, query).toBe(400);
    }
    expect((await request(`${path}/status?after=0`)).status).toBe(400);
    expect((await request(`${path}?root=fake`, { method: 'POST', token, body: JSON.stringify(message('fake')) })).status).toBe(400);
    for (const body of ['{', '[]', JSON.stringify({ ...message('fake'), root: 'fake' }), ' '.repeat(65537)]) {
      expect([400, 413]).toContain((await request(path, { method: 'POST', token, body })).status);
    }
    expect((await request(`${path}/extra`)).status).toBe(404);
    expect(append).not.toHaveBeenCalled();
  });
  it('requires read sessions and rejects unauthorized writes before append', async () => {
    const { append } = setup();
    expect((await request(path, { session: false })).status).toBe(401);
    expect((await request(`${path}/status`, { session: false })).status).toBe(401);
    expect((await request(path, { method: 'POST', body: JSON.stringify(message('fake')) })).status).toBe(401);
    expect((await request(path, { method: 'POST', token, dispatch: false, body: JSON.stringify(message('fake')) })).status).toBe(404);
    expect(append).not.toHaveBeenCalled();
  });
  it('distinguishes missing and broken sources from a readable empty page', async () => {
    const { root } = setup();
    expect(await request(path)).toMatchObject({ status: 200, wire: { status: 'ok', messages: [] } });
    writeFileSync(join(root, 'bus-inbox'), 'fake broken store');
    expect(await request(path)).toMatchObject({ status: 503, wire: { v: 1, status: 'unavailable' } });
    expect(await request(`${path}/status`)).toMatchObject({ status: 503, wire: { source: 'unavailable', retainedCount: null } });
  });
  it('maps capacity and retryable results without hiding store outcomes', async () => {
    for (const [storeStatus, httpStatus] of [['full', 507], ['retryable', 503], ['unavailable', 503]] as const) {
      const api = createAgentBusApi({ append: () => ({ status: storeStatus }) });
      setWorkbenchApiModulesForTest([{ id: 'agent-bus', load: async () => api }]);
      expect(await post(message('fake'))).toMatchObject({ status: httpStatus, wire: { v: 1, status: storeStatus } });
    }
  });
});
