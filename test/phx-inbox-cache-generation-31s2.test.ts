import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendInboxEntry, readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as RUNS, VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'fake-inbox-test-token';
const START = Date.parse('2026-10-31T12:00:00Z');
type Api = ReturnType<typeof createFleetRunsApi>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function request(api: Api, options: {
  method?: string; body?: unknown; token?: string | null; contentType?: string; allowDispatch?: boolean;
} = {}) {
  const method = options.method ?? 'GET';
  const path = method === 'GET' ? RUNS : INBOX;
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(options.body ?? {})]) as unknown as IncomingMessage;
  req.url = path;
  req.method = method;
  req.headers = { 'content-type': options.contentType ?? 'application/json' };
  if (options.token !== null) req.headers['x-ashlr-token'] = options.token ?? TOKEN;
  let status = 0;
  let wire: Record<string, unknown> = {};
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text) as Record<string, unknown>; },
  } as unknown as ServerResponse;
  const handled = await api({ token: TOKEN, allowDispatch: options.allowDispatch ?? true } as VerseApiContext, req, res, path, method);
  return { handled, status, wire };
}

const get = (api: Api) => request(api);
const post = (api: Api, text: string, options: Parameters<typeof request>[1] = {}) =>
  request(api, { ...options, method: 'POST', body: { text, source: 'Fake desktop' } });

describe('fleet inbox cache generations', () => {
  let runsDir: string;
  beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-inbox-generation-')); });
  afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

  function harness() {
    let tick = START;
    const gates: Array<{ started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }> = [];
    const holdNext = () => {
      const gate = { started: deferred(), release: deferred() };
      gates.push(gate);
      return gate;
    };
    const readInbox = vi.fn(async (limit: number) => {
      const gate = gates.shift();
      const snapshot = await readInboxEntries({ runsDir, limit });
      if (gate) { gate.started.resolve(); await gate.release.promise; }
      return snapshot;
    });
    const appendInbox = vi.fn(async (text: string, source: string) => {
      if (text === 'refuse this') return { ok: false, reason: 'empty' };
      return appendInboxEntry(text, { runsDir, source, now: () => new Date(tick) });
    });
    const api = createFleetRunsApi({
      now: () => tick, readInbox, appendInbox,
      readRunsDir: async () => null, listWorkers: async () => null,
      readHostLoad: () => null, codexPersonal: async () => null,
      mergedLastHour: async () => ({ count: 0, items: [] }),
    });
    return { api, readInbox, appendInbox, holdNext, advance: (ms: number) => { tick += ms; } };
  }

  it('does not publish an old snapshot that completes after acceptance', async () => {
    const h = harness();
    const oldGate = h.holdNext();
    const oldRead = get(h.api);
    await oldGate.started.promise;
    expect(await post(h.api, 'new order')).toMatchObject({ status: 201, wire: { accepted: true } });
    oldGate.release.resolve();
    expect(await oldRead).toMatchObject({ status: 200, wire: { inbox: [] } });
    expect(await get(h.api)).toMatchObject({ status: 200, wire: { inbox: [{ text: 'new order', source: 'Fake desktop' }] } });
    expect(h.readInbox).toHaveBeenCalledTimes(2);
  });

  it('starts and coalesces fresh reads while an old read remains unresolved', async () => {
    const h = harness();
    const oldGate = h.holdNext();
    const oldRead = get(h.api);
    await oldGate.started.promise;
    expect((await post(h.api, 'fresh order')).status).toBe(201);
    const freshGate = h.holdNext();
    const freshRead = get(h.api);
    await freshGate.started.promise;
    const concurrent = get(h.api);
    expect(h.readInbox).toHaveBeenCalledTimes(2);
    oldGate.release.resolve();
    expect(await oldRead).toMatchObject({ wire: { inbox: [] } });
    // The older build's cleanup must not discard the newer in-flight build.
    const another = get(h.api);
    expect(h.readInbox).toHaveBeenCalledTimes(2);
    freshGate.release.resolve();
    for (const response of await Promise.all([freshRead, concurrent, another])) {
      expect(response).toMatchObject({ status: 200, wire: { inbox: [{ text: 'fresh order' }] } });
    }
    expect(await get(h.api)).toMatchObject({ wire: { inbox: [{ text: 'fresh order' }] } });
    expect(h.readInbox).toHaveBeenCalledTimes(2);
  });

  it('keeps the fresh cache when the older read finishes last', async () => {
    const h = harness();
    const oldGate = h.holdNext();
    const oldRead = get(h.api);
    await oldGate.started.promise;
    expect((await post(h.api, 'newer order')).status).toBe(201);
    expect(await get(h.api)).toMatchObject({ wire: { inbox: [{ text: 'newer order' }] } });
    oldGate.release.resolve();
    expect(await oldRead).toMatchObject({ wire: { inbox: [] } });
    expect(await get(h.api)).toMatchObject({ wire: { inbox: [{ text: 'newer order' }] } });
    expect(h.readInbox).toHaveBeenCalledTimes(2);
  });

  it('retains cached and in-flight reads after duplicate and refused writes, until the two-second expiry', async () => {
    const h = harness();
    expect((await post(h.api, 'accepted order')).status).toBe(201);
    const gate = h.holdNext();
    const first = get(h.api);
    await gate.started.promise;
    expect(await post(h.api, 'accepted order')).toMatchObject({ status: 200, wire: { duplicate: true } });
    expect(await post(h.api, 'refuse this')).toMatchObject({ status: 422, wire: { code: 'INBOX_REFUSED' } });
    const concurrent = get(h.api);
    expect(h.readInbox).toHaveBeenCalledTimes(1);
    gate.release.resolve();
    await Promise.all([first, concurrent]);
    expect((await post(h.api, 'accepted order')).status).toBe(200);
    expect((await post(h.api, 'refuse this')).status).toBe(422);
    h.advance(1999);
    await get(h.api);
    expect(h.readInbox).toHaveBeenCalledTimes(1);
    h.advance(1);
    await get(h.api);
    expect(h.readInbox).toHaveBeenCalledTimes(2);
    expect(h.appendInbox).toHaveBeenCalledTimes(3);
  });

  it('preserves dispatch, token, content type and body checks without invalidating or reserving identity', async () => {
    const h = harness();
    await get(h.api);
    expect((await post(h.api, 'guarded', { allowDispatch: false })).status).toBe(404);
    expect((await post(h.api, 'guarded', { token: null })).status).toBe(401);
    expect((await post(h.api, 'guarded', { token: 'fake-wrong' })).status).toBe(401);
    expect((await post(h.api, 'guarded', { contentType: 'text/plain' })).status).toBe(415);
    expect((await request(h.api, { method: 'POST', body: { text: 'guarded', senderId: 'fake-other' } })).status).toBe(400);
    expect((await post(h.api, '   ')).status).toBe(400);
    expect(h.appendInbox).not.toHaveBeenCalled();
    await get(h.api);
    expect(h.readInbox).toHaveBeenCalledTimes(1);
    expect(await post(h.api, 'guarded')).toMatchObject({ status: 201, wire: { accepted: true } });
    expect(h.appendInbox).toHaveBeenCalledWith('guarded', 'Fake desktop');
    expect(await get(h.api)).toMatchObject({ wire: { inbox: [{ text: 'guarded' }] } });
    expect(h.readInbox).toHaveBeenCalledTimes(2);
  });
});
