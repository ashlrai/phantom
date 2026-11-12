/**
 * RQ-PHX-BOARDCONTRACTRECOVER184 — GET /api/fleet/board (recovered from #5007).
 * Goes through the real server's handleApi with an isolated ASHLR_RUNS_DIR.
 * The recording is evidence: lane numbers and unknown (null) values survive,
 * bad recordings degrade to missing/unavailable with a null board, and the
 * route never writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';

import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

let runs: string;
let prevRuns: string | undefined;
const handles: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'board-184-'));
  await mkdir(join(runs, 'coordination'), { recursive: true });
  prevRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
});

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => undefined);
  if (prevRuns === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = prevRuns;
  await rm(runs, { recursive: true, force: true });
});

const boardFile = () => join(runs, 'coordination', 'leader-board.json');

async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(e.isDirectory() ? `${p}/` : `${p}:${(await stat(p)).mtimeMs}:${(await stat(p)).size}`);
    if (e.isDirectory()) out.push(...await snapshotTree(p));
  }
  return out.sort();
}

async function get(auth = true): Promise<{ status: number; json: any }> {
  const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
  handles.push(h);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: h.port, path: '/api/fleet/board', method: 'GET',
      headers: { Host: `127.0.0.1:${h.port}`, ...(auth ? readAuthHeaders(h.port) : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(data); } catch { /* non-json */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

const recorded = (generatedAt: string) => ({
  schema: 'fleet.leader-board.v1',
  generatedAt,
  lanes: [
    { lane: 'codex-personal', ready: 12, parked: 3, running: 32, mergesLastHour: 7, oldestWaitSeconds: 90.5 },
    { lane: 'zai', ready: null, parked: 0, running: 0, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: null,
  mergesLastHour: null,
  conflictingPrs: { count: null, delta: null, trend: 'unknown', history: [] },
  needsMason: { status: 'unavailable', count: 0, items: [] },
  sources: { readyTsv: 'degraded', queueCounts: 'unavailable', needsMason: 'unavailable' },
});

describe('GET /api/fleet/board', () => {
  it('serves the recorded board with its own generatedAt, lane numbers and unknowns', async () => {
    const at = new Date(Date.now() - 120_000).toISOString();
    await writeFile(boardFile(), JSON.stringify(recorded(at)));
    const before = await snapshotTree(runs);
    const res = await get();
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(['ageSeconds', 'board', 'schema', 'status']);
    expect(res.json.schema).toBe('fleet.leader-board.v1');
    expect(res.json.status).toBe('ok');
    expect(res.json.board.generatedAt).toBe(at);
    expect(res.json.ageSeconds).toBeGreaterThanOrEqual(120);
    expect(res.json.ageSeconds).toBeLessThan(180);
    expect(res.json.board.lanes).toEqual(recorded(at).lanes);
    expect(res.json.board.mergesLastHour).toBeNull();
    expect(res.json.board.queueDepthByTier).toBeNull();
    expect(res.json.board.conflictingPrs.trend).toBe('unknown');
    expect(res.json.board.sources.readyTsv).toBe('degraded');
    expect(await snapshotTree(runs)).toEqual(before); // no writes
  });

  it('reports missing with a null board when nothing was recorded', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null });
    await expect(stat(boardFile())).rejects.toThrow(); // not created
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['wrong schema', JSON.stringify({ ...recorded(new Date().toISOString()), schema: 'other.v1' })],
    ['no generatedAt', JSON.stringify({ schema: 'fleet.leader-board.v1', lanes: [] })],
  ])('reports unavailable for %s', async (_name, text) => {
    await writeFile(boardFile(), text);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ schema: 'fleet.leader-board.v1', status: 'unavailable', ageSeconds: null, board: null });
  });

  it('reports unavailable for an oversized recording instead of reading it', async () => {
    await writeFile(boardFile(), JSON.stringify({ ...recorded(new Date().toISOString()), pad: 'x'.repeat(300 * 1024) }));
    const res = await get();
    expect(res.json.status).toBe('unavailable');
    expect(res.json.board).toBeNull();
  });

  it('refuses a symlinked recording', async () => {
    const target = join(runs, 'elsewhere.json');
    await writeFile(target, JSON.stringify(recorded(new Date().toISOString())));
    await symlink(target, boardFile());
    const res = await get();
    expect(res.json).toEqual({ schema: 'fleet.leader-board.v1', status: 'unavailable', ageSeconds: null, board: null });
  });

  it('keeps the read-auth boundary: no token, no board', async () => {
    await writeFile(boardFile(), JSON.stringify(recorded(new Date().toISOString())));
    const res = await get(false);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.json?.board).toBeUndefined();
  });
});
