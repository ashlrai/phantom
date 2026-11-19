/**
 * GET /api/fleet/job/window — the loopback hub serves fleet.job.window.v1
 * (same read class as /api/fleet/job/tail), and the remote phone gateway
 * admits exactly the reviewed shape: one id, lines, optional numeric cursor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import type { FleetJobWindowV1 } from '../src/core/fleet/job-window.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const JOB = 'RQ-ROUTEWINDOW';
let openHandles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of openHandles) { try { await h.close(); } catch { /* ignore */ } }
  openHandles = [];
});

function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port, path: parsed.pathname + parsed.search, method: 'GET',
        headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) } },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/fleet/job/window', () => {
  it('serves the window, then only newer lines after the cursor, and 400s on bad input', async () => {
    // test/setup/home.ts relocates HOME, so this is a scratch runs dir.
    const runs = join(homedir(), '.ashlr-runs');
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, `${JOB}.launch`), `launched ${JOB} claude pid 4242 base 1234abcd\n`);
    await writeFile(join(runs, `${JOB}.base.meta`), 'MODEL claude frontier opus\n');
    await writeFile(join(runs, `${JOB}.log`), 'one\ntwo\n');

    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);

    const res = await get(`${h.url}/api/fleet/job/window?id=${JOB}&lines=40`, h.port);
    expect(res.statusCode).toBe(200);
    const w = JSON.parse(res.body) as FleetJobWindowV1;
    expect(w).toMatchObject({ schema: 'fleet.job.window.v1', job: JOB, state: 'running', lane: 'claude', model: 'opus', repo: null });
    expect(w.log.lines).toEqual(['one', 'two']);
    expect(w.log.cursor).toBe(8);

    await appendFile(join(runs, `${JOB}.log`), 'three\n');
    const next = JSON.parse((await get(`${h.url}/api/fleet/job/window?id=${JOB}&after=${w.log.cursor}`, h.port)).body) as FleetJobWindowV1;
    expect(next.log).toMatchObject({ lines: ['three'], since: 8, cursor: 14 });

    for (const bad of ['', '?id=../etc', `?id=${JOB}&lines=0`, `?id=${JOB}&lines=201`, `?id=${JOB}&after=-1`, `?id=${JOB}&after=x`]) {
      expect((await get(`${h.url}/api/fleet/job/window${bad}`, h.port)).statusCode).toBe(400);
    }
    const unknown = JSON.parse((await get(`${h.url}/api/fleet/job/window?id=RQ-NOWHERE`, h.port)).body) as FleetJobWindowV1;
    expect(unknown).toMatchObject({ state: 'unknown', lane: null });
  });
});

describe('phone gateway: job window read boundary', () => {
  it.each([
    `/api/fleet/job/window?id=${JOB}&lines=1`,
    `/api/fleet/job/window?id=${JOB}&lines=200&after=0`,
    `/api/fleet/job/window?id=${JOB}&lines=40&after=123456`,
  ])('admits %s', (target) => {
    expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'read', path: '/api/fleet/job/window' });
  });

  it.each([
    '/api/fleet/job/window', `/api/fleet/job/window?id=${JOB}`, `/api/fleet/job/window?id=${JOB}&lines=0`,
    `/api/fleet/job/window?id=${JOB}&lines=201`, `/api/fleet/job/window?id=${JOB}&lines=1&after=-1`,
    `/api/fleet/job/window?id=${JOB}&lines=1&after=1234567890123456`, `/api/fleet/job/window?id=${JOB}&lines=1&extra=1`,
    `/api/fleet/job/window?id=../abc&lines=1`, `/api/fleet/job/window?id=${JOB}&id=RQ-OTHER&lines=1`,
    `/api/fleet/job/window?id=${JOB}&lines=1&after=1%0a`,
  ])('denies %s', (target) => {
    expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'deny' });
  });

  it.each(['POST', 'DELETE', 'PUT'])('denies %s', (method) => {
    expect(classifyRemoteRoute(method, `/api/fleet/job/window?id=${JOB}&lines=1`)).toEqual({ kind: 'deny' });
  });
});
