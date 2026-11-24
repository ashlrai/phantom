/**
 * fleet-ideas-api.test.ts: the typed API behind the Ideas view's "Fix next"
 * card (RQ-IDEASLOOPN17DQ8). GET answers the same report as `phm ideas list`;
 * POST "Queue it" is dispatch + token + JSON gated and writes one drop job.
 * Served through the fleet-control family; ASHLR_RUNS_DIR is a temp dir.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ideaJobId } from '../src/core/fleet/bottleneck-ideas.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { handleFleetIdeasApi, VERSE_FLEET_IDEAS_PATH, VERSE_FLEET_IDEAS_QUEUE_PATH } from '../src/core/verse/fleet-ideas-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'test-token-ideas';
const writeCtx = { cfg: {}, token: TOKEN, allowDispatch: true } as unknown as VerseApiContext;
const readCtx = { cfg: {}, token: TOKEN, allowDispatch: false } as unknown as VerseApiContext;
const json = { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' };

let runs: string;
beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'ashlr-fleet-ideas-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  mkdirSync(join(runs, 'queue'), { recursive: true });
  writeFileSync(join(runs, 'queue', 'status.json'), JSON.stringify({ lanes: { claude: { running: 0, target: 2, queued: 3, held: false } } }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runs, { recursive: true, force: true }); });

async function call(path: string, opts: { ctx?: VerseApiContext; method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const method = opts.method ?? 'GET';
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = opts.headers ?? {};
  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)));
    req.emit('end');
  });
  let status = 0, text = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; return this; }, end(body?: string) { text += body ?? ''; }, write() { return true; } } as unknown as ServerResponse;
  // Through the fleet-control family, exactly as the server mounts it.
  const handled = await handleFleetControlApi(opts.ctx ?? readCtx, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}
const post = (body: unknown, ctx = writeCtx, headers = json) => call(VERSE_FLEET_IDEAS_QUEUE_PATH, { ctx, method: 'POST', headers, body });

describe('GET ideas', () => {
  it('answers read-only with the ranked list and unknown signals', async () => {
    const r = await call(VERSE_FLEET_IDEAS_PATH);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body.schema).toBe('fleet.idea-list.v1');
    expect(r.body.ideas.map((idea: { id: string }) => idea.id)).toEqual(['idle-lanes:claude']);
    expect(r.body.signals.find((s: { name: string }) => s.name === 'disk-trend')).toMatchObject({ status: 'unknown' });
  });
  it('refuses other methods', async () => {
    expect((await call(VERSE_FLEET_IDEAS_PATH, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('POST ideas/queue', () => {
  it('is a 404 without dispatch, 401 without the token, 415 without JSON', async () => {
    expect((await post({ id: 'idle-lanes:claude' }, readCtx)).status).toBe(404);
    expect((await post({}, writeCtx, { 'content-type': 'application/json' } as typeof json)).status).toBe(401);
    expect((await post({}, writeCtx, { 'x-ashlr-token': TOKEN } as typeof json)).status).toBe(415);
  });

  it('rejects extra fields, bad ids and ideas not on the list, writing nothing', async () => {
    for (const [body, status] of [[{ id: 'idle-lanes:claude', lane: 'x' }, 400], [{ id: '../x' }, 400], ['not json', 400], [{ id: 'idle-lanes:other' }, 404]] as const) {
      expect((await post(body)).status).toBe(status);
    }
    expect(() => readdirSync(join(runs, 'leader'))).toThrow();
  });

  it('queues a current idea once', async () => {
    const jobId = ideaJobId('idle-lanes:claude');
    const first = await post({ id: 'idle-lanes:claude' });
    expect(first).toMatchObject({ status: 200, body: { ideaId: 'idle-lanes:claude', jobId, queued: true, existing: false } });
    expect((await post({ id: 'idle-lanes:claude' })).body).toMatchObject({ queued: false, existing: true });
    expect((await call(VERSE_FLEET_IDEAS_PATH)).body.ideas[0]).toMatchObject({ status: 'queued', lane: 'claude', why: expect.any(String) });
    expect(readdirSync(join(runs, 'leader', 'drop', 'claude')).filter(name => !name.startsWith('.'))).toEqual([`RQ-PHX-${jobId}.md`]);
  });

  it('leaves other paths to the next module', async () => {
    const req = new EventEmitter() as IncomingMessage;
    expect(await handleFleetIdeasApi(readCtx, req, {} as ServerResponse, '/api/verse/fleet/control/other', 'GET')).toBe(false);
  });
});
