/**
 * RQ-PHX-RECUTDESKN3S130 recut pin — fleet.sessions.v1 (PR #3918).
 *
 * Pins the PR's main user-visible behavior through the real module path:
 *   GET /api/fleet/sessions → handleApi → getFleetSessions() → fleet.sessions.v1
 *
 * A queued ready.tsv row and a dispatched run-marker session must surface in
 * the loopback response, and prompt paths must never leave the projection
 * (the value-blind contract that makes this surface safe to show).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';

import { getFleetSessions, type FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname, port, path: parsed.pathname + parsed.search,
        method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) },
      },
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

const openHandles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of openHandles.splice(0)) {
    try { await h.close(); } catch { /* ignore */ }
  }
});

describe('GET /api/fleet/sessions (recut pin)', () => {
  it('serves fleet.sessions.v1 with queued and dispatched sessions, value-blind', async () => {
    // The suite HOME is relocated (test/setup/home.ts); seed the default runs dir.
    const runs = join(homedir(), '.ashlr-runs');
    await mkdir(join(runs, 'queue', 'run'), { recursive: true });
    await writeFile(join(runs, 'queue', 'ready.tsv'), 'S130-QUEUED\tphantom\tcodex-cmp\twork\t/p/s130q.md\n');
    await writeFile(join(runs, 'queue', 'run', 'S130-RUN.line'), 'S130-RUN\tphantom\tdevin\tmid\t/p/s130r.md\n');
    await writeFile(join(runs, 'queue', 'run', 'S130-RUN.dispatched'), String(Math.floor(Date.now() / 1000) - 30));

    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);

    const res = await get(`${h.url}/api/fleet/sessions`, h.port);
    expect(res.statusCode).toBe(200);
    const snap = JSON.parse(res.body) as FleetSessionsV1;
    expect(snap.schema).toBe('fleet.sessions.v1');
    const jobs = new Set([...snap.sessions, ...snap.recent].map((s) => s.job));
    expect(jobs.has('S130-QUEUED')).toBe(true);
    expect(jobs.has('S130-RUN')).toBe(true);
    // Read-only and value-blind end to end: no prompt path leaks.
    expect(res.body).not.toContain('/p/s130q.md');
    expect(res.body).not.toContain('/p/s130r.md');
  });
});

describe('getFleetSessions (recut pin)', () => {
  it('classifies a queued row as queued and keeps the prompt path out of the row', async () => {
    const dir = join(tmpdir(), `s130-runs-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue', 'ready.tsv'), 'S130-Q2\tphantom\tdevin\twork\t/prompt/secret-path.md\n');
    try {
      const snap = await getFleetSessions({ runsDir: dir, runPs: async () => '' });
      const row = snap.sessions.find((s) => s.job === 'S130-Q2');
      expect(row?.status).toBe('queued');
      expect(JSON.stringify(row)).not.toContain('/prompt/');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
