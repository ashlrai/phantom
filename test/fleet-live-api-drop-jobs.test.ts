/**
 * RQ-PHX-DROPJOBAPI31 — /api/verse/fleet/live/drop-jobs through the real
 * server: handleApi → verse-api dispatch → handleFleetLiveApi → the drop-job
 * writer, against an injected ASHLR_RUNS_DIR root and fake tokens only.
 *
 *   POST {id, lane, tier, body} → 201 {v:1, status:'written', file, bytes, at}
 *   invalid input → 400 {status:'invalid', reasons}; used id → 409
 *   {status:'exists'}; 40+ queued prompts → 507 {status:'full'}; write
 *   failure → 503. GET → {v:1, items:[…]} ({v:1, items:[]} when empty).
 *   No read session → 401 on the GET; dispatch off → 404 on the POST.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig, WebServerHandle, WebServerOptions } from '../src/core/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import { DROP_JOB_FILE_PREFIX } from '../src/core/fleet/drop-job-writer.js';

const ROUTE = '/api/verse/fleet/live/drop-jobs';
const GOOD = { id: 'BRIDGE01', lane: 'claude', tier: 'work', body: 'Summarize the merge backlog.' };

const cfg = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
} as AshlrConfig;

const opts = (overrides: Partial<WebServerOptions> = {}): WebServerOptions => ({ port: 0, open: false, allowDispatch: true, ...overrides });

let handles: WebServerHandle[] = [];
let runsRoot = '';
const tmpRoots: string[] = [];
let previousRunsDir: string | undefined;

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-jobs-api-'));
  tmpRoots.push(dir);
  return dir;
}

async function boot(overrides: Partial<WebServerOptions> = {}) {
  const handle = await startServer(cfg, opts(overrides));
  handles.push(handle);
  const read = readAuthHeaders(handle.port);
  const mutate = { 'x-ashlr-token': handle.token, 'content-type': 'application/json' };
  return { handle, port: handle.port, read, mutate };
}

interface HttpResult { status: number; body: string; json: Record<string, unknown> }
function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const dropLane = (): string => path.join(runsRoot, 'leader', 'drop', 'claude');
const dropFile = (id: string): string => path.join(dropLane(), `${DROP_JOB_FILE_PREFIX}${id}.md`);

beforeEach(() => {
  runsRoot = tempRoot();
  previousRunsDir = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = runsRoot;
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  if (previousRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRunsDir;
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('POST /api/verse/fleet/live/drop-jobs', () => {
  it('writes a validated job file and reports its bytes', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ v: 1, status: 'written', file: `leader/drop/claude/${DROP_JOB_FILE_PREFIX}${GOOD.id}.md` });
    const text = fs.readFileSync(dropFile(GOOD.id), 'utf8');
    expect(text.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(text).toBe(`#job repo=phantom lane=claude tier=work\n\n${GOOD.body}\n`);
    expect(res.json['bytes']).toBe(Buffer.byteLength(text, 'utf8'));
    expect(typeof res.json['at']).toBe('string');
  });

  it('answers 409 on a repost and leaves the file untouched', async () => {
    const { port, mutate } = await boot();
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD))).status).toBe(201);
    const first = fs.readFileSync(dropFile(GOOD.id), 'utf8');
    const again = await request(port, 'POST', ROUTE, mutate, JSON.stringify({ ...GOOD, body: 'something else' }));
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ status: 'exists' });
    expect(fs.readFileSync(dropFile(GOOD.id), 'utf8')).toBe(first);
  });

  it('answers 409 when the id is already queued or launched', async () => {
    const { port, mutate } = await boot();
    fs.mkdirSync(path.join(runsRoot, 'queue', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, 'queue', 'prompts', `${DROP_JOB_FILE_PREFIX}${GOOD.id}.md`), 'x');
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD))).status).toBe(409);
    fs.rmSync(path.join(runsRoot, 'queue', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, `${DROP_JOB_FILE_PREFIX}${GOOD.id}.prompt`), 'x');
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD))).status).toBe(409);
  });

  it('answers 400 with the matching reasons on invalid jobs', async () => {
    const { port, mutate } = await boot();
    const denied = await request(port, 'POST', ROUTE, mutate, JSON.stringify({ ...GOOD, body: 'check .github/workflows/ci.yml' }));
    expect(denied.status).toBe(400);
    expect(denied.json).toMatchObject({ status: 'invalid', reasons: ['denied-content'] });
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify({ ...GOOD, lane: 'grok' }))).json)
      .toMatchObject({ status: 'invalid', reasons: ['lane'] });
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify({ ...GOOD, id: 'lower' }))).json)
      .toMatchObject({ status: 'invalid', reasons: ['id-shape'] });
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify({ ...GOOD, body: 'x'.repeat(9000) }))).json)
      .toMatchObject({ status: 'invalid', reasons: ['too-large'] });
    expect((await request(port, 'POST', ROUTE, mutate, JSON.stringify({ ...GOOD, extra: true }))).json)
      .toMatchObject({ status: 'invalid', reasons: ['unexpected-keys'] });
    expect(fs.existsSync(dropLane())).toBe(false); // nothing was written
  });

  it('answers 400 on a non-object body and 413 past the 16 KB envelope', async () => {
    const { port, mutate } = await boot();
    expect((await request(port, 'POST', ROUTE, mutate, 'not json')).status).toBe(400);
    expect((await request(port, 'POST', ROUTE, mutate, '[1,2]')).status).toBe(400);
    const fat = JSON.stringify({ ...GOOD, body: 'x'.repeat(20 * 1024) });
    expect((await request(port, 'POST', ROUTE, mutate, fat)).status).toBe(413);
  });

  it('answers 507 when the prompt queue already holds forty jobs', async () => {
    const { port, mutate } = await boot();
    const prompts = path.join(runsRoot, 'queue', 'prompts');
    fs.mkdirSync(prompts, { recursive: true });
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(prompts, `${DROP_JOB_FILE_PREFIX}FILL${String(i).padStart(3, '0')}.md`), 'x');
    fs.writeFileSync(path.join(prompts, 'not-a-job.md'), 'x'); // ignored by the count
    const res = await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD));
    expect(res.status).toBe(507);
    expect(res.json).toMatchObject({ status: 'full' });
    expect(fs.existsSync(dropFile(GOOD.id))).toBe(false);
  });

  it('answers 503 when the drop lane cannot be written', async () => {
    const { port, mutate } = await boot();
    fs.mkdirSync(path.join(runsRoot, 'leader', 'drop'), { recursive: true });
    fs.writeFileSync(dropLane(), 'i am a file, not a directory');
    const res = await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD));
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 'failed' });
  });

  it('answers 404 without dispatch, 401 without the mutation token and 415 without JSON', async () => {
    const off = await boot({ allowDispatch: false });
    expect((await request(off.port, 'POST', ROUTE, off.mutate, JSON.stringify(GOOD))).status).toBe(404);
    const { port, read, handle } = await boot();
    expect((await request(port, 'POST', ROUTE, { 'content-type': 'application/json' }, JSON.stringify(GOOD))).status).toBe(401);
    // The read token authorizes reads only — never mutations.
    expect((await request(port, 'POST', ROUTE, { ...read, 'content-type': 'application/json' }, JSON.stringify(GOOD))).status).toBe(401);
    expect((await request(port, 'POST', ROUTE, { 'x-ashlr-token': handle.token }, JSON.stringify(GOOD))).status).toBe(415);
    expect(fs.existsSync(dropLane())).toBe(false);
  });
});

describe('GET /api/verse/fleet/live/drop-jobs', () => {
  it('answers {v:1, items:[]} for an empty lane', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', ROUTE, read);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ v: 1, items: [] });
  });

  it('lists the waiting job with its title and age', async () => {
    const { port, read, mutate } = await boot();
    await request(port, 'POST', ROUTE, mutate, JSON.stringify(GOOD));
    const res = await request(port, 'GET', ROUTE, read);
    expect(res.status).toBe(200);
    const items = res.json['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: GOOD.id, lane: 'claude', tier: 'work', title: GOOD.body });
    expect(items[0]!['bytes']).toBe(fs.statSync(dropFile(GOOD.id)).size);
    expect(items[0]!['ageSeconds']).toBeGreaterThanOrEqual(0);
  });

  it('refuses unknown query parameters', async () => {
    const { port, read } = await boot();
    expect((await request(port, 'GET', `${ROUTE}?limit=1`, read)).status).toBe(400);
  });

  it('answers 401 without a read session and 405 on other methods', async () => {
    const { port, read, mutate } = await boot();
    expect((await request(port, 'GET', ROUTE)).status).toBe(401);
    expect((await request(port, 'PUT', ROUTE, mutate, '{}')).status).toBe(405);
    // The route family owns the path; anything under it is a real 404.
    expect((await request(port, 'GET', `${ROUTE}/nope`, read)).status).toBe(404);
  });
});
