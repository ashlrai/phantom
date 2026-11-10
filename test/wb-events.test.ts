/**
 * wb-events.test.ts — GET /api/wb/v1/events (WB-8 SSE surface) coverage.
 *
 *   - Route boundary: no/expired read session → 401 SESSION_REQUIRED, wrong
 *     method → 405, unknown subpath → 404, non-wb path falls through.
 *   - Stream contract: `event:` matches the envelope `kind`, frames are
 *     schema-valid workbench.event.v1 (wb.snapshot / wb.gh / wb.action) and
 *     `seq` is per-connection monotonic.
 *   - Change detection: wb.snapshot/wb.gh emit only when their digest flips;
 *     wb.action is pushed through publishWbEvent().
 *   - Session expiry ends the stream.
 *
 * Hermetic: drives handleWbApi (the real /api/wb/v1/* entry point) with a
 * fake req/res — no sockets, no files, no gh subprocess; the poll cadence
 * and both read projections arrive through WbEventsDeps seams.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AshlrConfig } from '../src/core/types.js';
import { handleWbApi } from '../src/core/web/wb-read-api.js';
import {
  publishWbEvent,
  WB_EVENTS_PATH,
  type WbEventsDeps,
} from '../src/core/web/wb-events.js';
import { validateWorkbench } from '../src/core/workbench/schema.js';

const SCHEMA_DIR = join(__dirname, '..', 'schema', 'workbench.v1');

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

// ---------------------------------------------------------------------------
// Fake req/res — enough of the http surface for sendJson + the SSE handler.
// ---------------------------------------------------------------------------

class FakeSseResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  writableLength = 0;

  writeHead(code: number, headers: Record<string, string>): this {
    this.status = code;
    this.headers = headers;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  end(data?: string | Uint8Array): this {
    if (data !== undefined) this.chunks.push(String(data));
    this.ended = true;
    return this;
  }

  /** Decoded SSE frames so far: [{id?, event, data}]. */
  frames(): { event: string; data: string }[] {
    const out: { event: string; data: string }[] = [];
    for (const block of this.chunks.join('').split('\n\n')) {
      const frame = { event: 'message', data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data += (frame.data ? '\n' : '') + line.slice(5).trim();
      }
      if (frame.data || frame.event !== 'message') out.push(frame);
    }
    return out;
  }
}

function makeReq(method = 'GET'): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.headers = {};
  return req;
}

const open: { req: IncomingMessage; res: FakeSseResponse }[] = [];

afterEach(() => {
  for (const { req } of open.splice(0)) {
    try { req.emit('close'); } catch { /* ignore */ }
  }
});

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('waitFor timed out');
}

const freshSession = () => ({ id: `sess-${open.length}`, expiresAt: Date.now() + 60_000 });

/** Call the real route dispatcher exactly as api.ts does. */
async function dispatch(
  path: string,
  deps: Parameters<typeof handleWbApi>[4] = {},
  method = 'GET',
): Promise<{ handled: boolean; req: IncomingMessage; res: FakeSseResponse }> {
  const req = makeReq(method);
  const res = new FakeSseResponse();
  const handled = await handleWbApi(
    req,
    res as unknown as ServerResponse,
    makeConfig(),
    path,
    deps,
  );
  return { handled, req, res };
}

function connect(events: WbEventsDeps = {}): { req: IncomingMessage; res: FakeSseResponse } {
  const pair = { req: makeReq(), res: new FakeSseResponse() };
  open.push(pair);
  void handleWbApi(
    pair.req,
    pair.res as unknown as ServerResponse,
    makeConfig(),
    WB_EVENTS_PATH,
    { readSession: freshSession(), events: { pollMs: 50, keepaliveMs: 60_000, ...events } },
  );
  return pair;
}

// ---------------------------------------------------------------------------
// Route boundary
// ---------------------------------------------------------------------------

describe('GET /api/wb/v1/events boundary', () => {
  it('requires a minted read session (SESSION_REQUIRED), never the bare token', async () => {
    const { handled, res } = await dispatch(WB_EVENTS_PATH);
    expect(handled).toBe(true);
    expect(res.status).toBe(401);
    expect(res.chunks.join('')).toContain('SESSION_REQUIRED');
  });

  it('an expired session is refused the same way', async () => {
    const { res } = await dispatch(WB_EVENTS_PATH, {
      readSession: { id: 'sess-old', expiresAt: Date.now() - 1 },
    });
    expect(res.status).toBe(401);
  });

  it('POST → 405 with Allow: GET', async () => {
    const { res } = await dispatch(WB_EVENTS_PATH, { readSession: freshSession() }, 'POST');
    expect(res.status).toBe(405);
    expect(res.headers['Allow']).toBe('GET');
  });

  it('unknown wb subpaths still 404 and a non-wb path falls through', async () => {
    const miss = await dispatch('/api/wb/v1/nope', { readSession: freshSession() });
    expect(miss.handled).toBe(true);
    expect(miss.res.status).toBe(404);
    const outside = await dispatch('/api/other');
    expect(outside.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stream contract
// ---------------------------------------------------------------------------

describe('GET /api/wb/v1/events stream', () => {
  it('answers SSE headers and emits schema-valid wb.snapshot + wb.gh envelopes', async () => {
    const { res } = connect({
      snapshotState: () => ({ state: 'ok', seats: 1 }),
      ghStatus: async () => ({ repos: [] }),
    });

    await waitFor(() => res.frames().some((f) => f.event === 'wb.snapshot')
      && res.frames().some((f) => f.event === 'wb.gh'));

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.chunks[0]).toBe(': connected\n\n');

    for (const frame of res.frames()) {
      const payload: unknown = JSON.parse(frame.data);
      expect(validateWorkbench(SCHEMA_DIR, 'event', payload)).toEqual([]);
      expect((payload as { kind: string }).kind).toBe(frame.event);
    }
    const seqs = res.frames().map((f) => (JSON.parse(f.data) as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('re-emits wb.snapshot only when the projection digest changes', async () => {
    let seats = 0;
    const { res } = connect({
      snapshotState: () => ({ state: 'ok', seats }),
      ghStatus: async () => ({ repos: ['ashlrai/phantom'] }),
    });

    await waitFor(() => res.frames().filter((f) => f.event === 'wb.snapshot').length >= 1);
    const baseline = res.frames().filter((f) => f.event === 'wb.snapshot').length;

    // Poll with an unchanged projection: no new frame.
    await new Promise((r) => setTimeout(r, 200));
    expect(res.frames().filter((f) => f.event === 'wb.snapshot')).toHaveLength(baseline);

    seats = 2;
    await waitFor(() => res.frames().filter((f) => f.event === 'wb.snapshot').length > baseline);
  });

  it('publishWbEvent broadcasts wb.action; invalid fields degrade, never an invalid frame', async () => {
    const { res } = connect({
      snapshotState: () => ({ state: 'ok' }),
      ghStatus: async () => null,
    });
    await waitFor(() => res.frames().length >= 1);

    const audit = {
      schema: 'workbench.audit-row.v1',
      ts: '2026-11-10T03:00:00Z',
      actor: 'ui',
      verb: 'job.merge',
      args: { rq_id: 'RQ-DESK-7-EVENTS', repo: 'ashlrai/phantom', pr: 4622, priority: 'P1' },
      dry_run: true,
      result: 'planned',
      refusal_reason: null,
      command: ['phm', 'merge', '4622'],
    };
    publishWbEvent('wb.action', { repo: 'ashlrai/phantom', audit });
    // A non-object audit / off-pattern repo is dropped, not emitted.
    publishWbEvent('wb.action', { repo: 'https://example.invalid/oops' as string, audit: 'bogus' as unknown as object });

    await waitFor(() => res.frames().filter((f) => f.event === 'wb.action').length >= 2);
    const actions = res.frames().filter((f) => f.event === 'wb.action').map((f) => JSON.parse(f.data) as Record<string, unknown>);
    expect(actions[0]!['repo']).toBe('ashlrai/phantom');
    expect(actions[0]!['audit']).toMatchObject({ schema: 'workbench.audit-row.v1' });
    expect(actions[1]!['repo']).toBeUndefined();
    expect(actions[1]!['audit']).toBeUndefined();
    for (const payload of actions) {
      expect(validateWorkbench(SCHEMA_DIR, 'event', payload)).toEqual([]);
    }
  });

  it('the read-session expiry ends the stream', async () => {
    const req = makeReq();
    const res = new FakeSseResponse();
    open.push({ req, res });
    await handleWbApi(
      req,
      res as unknown as ServerResponse,
      makeConfig(),
      WB_EVENTS_PATH,
      {
        readSession: { id: 'sess-short', expiresAt: Date.now() + 120 },
        events: { pollMs: 50, snapshotState: () => null, ghStatus: async () => null },
      },
    );
    expect(res.status).toBe(200);
    await waitFor(() => res.ended, 3_000);
  });
});
