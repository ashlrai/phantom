/**
 * RQ-PHX-RELEASECHAINHTTPRECOVER190S — preserves the authenticated HTTP cases
 * from PR #4973's test/release-chain-salvage128.test.ts (source
 * 008268ef657e2c525c5568d513083abefa19c9e4) against the current reader, plus
 * the publication-proof assertions the recovery order requires: signing
 * rc=0 alone is never `published`; a bound feed receipt is.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const SHA = 'feedface0123';
const OTHER_SHA = '0123456789ab';
let root: string;
let prior: string | undefined;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chain-http190s-')); prior = process.env.ASHLR_RUNS_DIR; process.env.ASHLR_RUNS_DIR = root; });
afterEach(() => {
  if (prior === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

function request(port: number, method: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/fleet/release-chain', method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => { let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body })); });
    req.on('error', reject);
    req.end();
  });
}

const get = (port: number, headers: Record<string, string>) => request(port, 'GET', headers);
const post = (port: number, headers: Record<string, string>) => request(port, 'POST', headers);

function writeRc(sha: string, rc: number): void {
  const autorun = join(root, 'release-sign', 'autorun');
  mkdirSync(autorun, { recursive: true });
  writeFileSync(join(autorun, `sha-${sha}.rc`), String(rc));
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
    writeFileSync(join(sign, 'v2.0.2-222.log'), `START v2.0.2 ${OTHER_SHA}\nReason: wrong run\n`);
    const held = await get(h.port, auth);
    expect(held.status).toBe(200);
    expect(JSON.parse(held.body)).toMatchObject({ verdict: 'held', reason: 'Reason: signing is held', version: '2.0.1', latestAutorun: { sha: SHA, rc: 12 } });
  } finally { await h.close(); }
});

it('never attaches a mismatched sha log version or reason', async () => {
  const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
  try {
    const auth = readAuthHeaders(h.port);
    writeRc(SHA, 12);
    const sign = join(root, 'release-sign');
    writeFileSync(join(sign, 'v9.9.9-333.log'), `START v9.9.9 ${OTHER_SHA}\nReason: another run held\n`);
    const res = await get(h.port, auth);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ verdict: 'held', reason: null, version: null, latestAutorun: { sha: SHA, rc: 12 } });
  } finally { await h.close(); }
});

it('signing rc=0 alone stays unknown; a bound feed receipt proves published', async () => {
  const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
  try {
    const auth = readAuthHeaders(h.port);
    const autorun = join(root, 'release-sign', 'autorun');
    mkdirSync(autorun, { recursive: true });
    writeFileSync(join(autorun, `sha-${SHA}.rc`), '0');
    writeFileSync(join(root, 'release-sign', 'v2.0.1-111.log'), `START v2.0.1 ${SHA}\nReason: signed ok\n`);

    const unproven = await get(h.port, auth);
    expect(unproven.status).toBe(200);
    const unprovenBody = JSON.parse(unproven.body);
    expect(unprovenBody).toMatchObject({ verdict: 'unknown', version: '2.0.1', latestAutorun: { sha: SHA, rc: 0 } });
    expect(unprovenBody.evidence.feedRc).toBeNull();

    // The proven feed receipt (rc + sha-bound json) is what upgrades the verdict.
    writeFileSync(join(autorun, `feed-${SHA}.rc`), '0');
    writeFileSync(join(autorun, `feed-${SHA}.json`), JSON.stringify({ kind: 'desktop-update-channel-check', sha: SHA, tag: 'v2.0.1', state: 'verified-live' }));
    const published = await get(h.port, auth);
    expect(published.status).toBe(200);
    expect(JSON.parse(published.body)).toMatchObject({
      verdict: 'published', version: '2.0.1',
      latestAutorun: { sha: SHA, rc: 0 },
      evidence: { versionJoin: 'feed-receipt', feedRc: 0, feedState: 'verified-live' },
    });
  } finally { await h.close(); }
});

it('rejects unauthenticated reads and unsupported methods cannot mutate', async () => {
  const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
  try {
    const auth = readAuthHeaders(h.port);
    expect((await get(h.port, {})).status).toBeGreaterThanOrEqual(400);
    expect((await post(h.port, auth)).status).toBe(404);
    writeRc(SHA, 12);
    const after = await get(h.port, auth);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body)).toMatchObject({ verdict: 'held', latestAutorun: { sha: SHA, rc: 12 } });
  } finally { await h.close(); }
});
