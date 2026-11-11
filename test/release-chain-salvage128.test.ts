/**
 * RQ-PHX-RELEASECHAINSALVAGE128 — GET /api/fleet/release-chain through the real
 * authenticated HTTP path, reading a temporary ASHLR_RUNS_DIR (no host fixtures).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const SHA = 'feedface0123';
let root: string;
let prior: string | undefined;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chain-salvage128-')); prior = process.env.ASHLR_RUNS_DIR; process.env.ASHLR_RUNS_DIR = root; });
afterEach(() => {
  if (prior === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

function get(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/fleet/release-chain', method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => { let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body })); });
    req.on('error', reject);
    req.end();
  });
}

it('serves unknown without evidence, then the held reason bound to the matching signing sha', async () => {
  const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
  try {
    const auth = readAuthHeaders(h.port);
    expect((await get(h.port, {})).status).toBeGreaterThanOrEqual(400); // auth boundary intact
    const empty = await get(h.port, auth);
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body)).toMatchObject({ verdict: 'unknown', reason: null, version: null, latestAutorun: null });

    const sign = join(root, 'release-sign');
    mkdirSync(join(sign, 'autorun'), { recursive: true });
    writeFileSync(join(sign, 'autorun', `sha-${SHA}.rc`), '12');
    writeFileSync(join(sign, 'v2.0.1-111.log'), `START v2.0.1 ${SHA}\nReason: signing is held\n`);
    // A log for a different sha must never lend its reason to this one.
    writeFileSync(join(sign, 'v2.0.2-222.log'), 'START v2.0.2 0123456789ab\nReason: wrong run\n');
    const held = await get(h.port, auth);
    expect(held.status).toBe(200);
    expect(JSON.parse(held.body)).toMatchObject({ verdict: 'held', reason: 'Reason: signing is held', version: '2.0.1', latestAutorun: { sha: SHA, rc: 12 } });
  } finally { await h.close(); }
});
