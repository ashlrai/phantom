/**
 * RQ-QUEUE-5: GET /api/queue/stats — the live station graph's feed.
 *
 * The route serves the same estimateQueueStats payload `phm queue stats
 * --json` prints, computed over the private queue-visit journal in the
 * (test-relocated) home directory. Covered here:
 *   - 401 at the boundary without a read session (default-deny GETs).
 *   - 200 with empty groups when the journal does not exist.
 *   - 200 reflecting visits recorded in the journal (rho, queue, wip).
 *   - 400 on a non-positive/NaN ?window=.
 *   - 500 on a corrupt journal (no journal contents echoed).
 *   - POST is rejected by the read-only route.
 *   - No secret-shaped journal contents ever serialised: identifiers are
 *     producer-chosen slugs, and the route copies only whitelisted fields.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AshlrConfig, WebServerOptions, WebServerHandle } from '../src/core/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import { recordQueueVisit, queueJournalPath } from '../src/core/queue/journal.js';

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

const handles: WebServerHandle[] = [];
async function serve(): Promise<WebServerHandle> {
  const handle = await startServer(makeConfig(), { port: 0, open: false, allowDispatch: false } satisfies WebServerOptions);
  handles.push(handle);
  return handle;
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
  await rm(dirname(queueJournalPath()), { recursive: true, force: true });
});

function req(
  method: string, port: number, path: string, headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

describe('GET /api/queue/stats', () => {
  it('requires read authority at the server boundary', async () => {
    const h = await serve();
    const res = await req('GET', h.port, '/api/queue/stats');
    expect(res.statusCode).toBe(401);
  });

  it('answers the schemaVersion 1 payload with empty groups on a missing journal', async () => {
    const h = await serve();
    const res = await req('GET', h.port, '/api/queue/stats', readAuthHeaders(h.port));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.schemaVersion).toBe(1);
    expect(body.stations).toEqual([]);
    expect(body.pools).toEqual([]);
    expect(body.units).toMatchObject({ rates: 'per-second', durations: 'seconds' });
  });

  it('reflects visits recorded in the journal with rho and queue depth', async () => {
    const now = Date.now();
    // Two visits at 'pr-ci': one done after a 4s wait + 10s service, one still waiting.
    await recordQueueVisit({ id: 'j1', station: 'pr-ci', pool: 'codex-a', arrivedAt: now - 60_000, startedAt: now - 56_000, completedAt: now - 46_000 });
    await recordQueueVisit({ id: 'j2', station: 'pr-ci', pool: 'codex-a', arrivedAt: now - 10_000 });
    const h = await serve();
    const res = await req('GET', h.port, '/api/queue/stats?window=3600', readAuthHeaders(h.port));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const station = body.stations.find((s: { station: string }) => s.station === 'pr-ci');
    expect(station).toBeDefined();
    const w = station.windows[0];
    expect(w.windowMs).toBe(3_600_000);
    expect(w.arrivals).toBe(2);
    expect(w.departures).toBe(1);
    expect(w.mu).toBeCloseTo(0.1, 5);
    expect(w.rho).toBeGreaterThan(0);
    expect(w.currentQueueLength).toBe(1);
    const pool = body.pools.find((p: { pool: string }) => p.pool === 'codex-a');
    expect(pool.windows[0].currentWip).toBeGreaterThan(0);
  });

  it('rejects a non-positive or non-numeric window', async () => {
    const h = await serve();
    for (const bad of ['abc', '-5', '0', 'NaN']) {
      const res = await req('GET', h.port, `/api/queue/stats?window=${bad}`, readAuthHeaders(h.port));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/window/);
    }
  });

  it('answers 500 on a corrupt journal without echoing its contents', async () => {
    await mkdir(dirname(queueJournalPath()), { recursive: true });
    await writeFile(queueJournalPath(), '{"id":"sk-not-a-real-visit\n', 'utf8');
    const h = await serve();
    const res = await req('GET', h.port, '/api/queue/stats', readAuthHeaders(h.port));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('sk-not-a-real-visit');
  });

  it('does not accept POST', async () => {
    const h = await serve();
    const res = await req('POST', h.port, '/api/queue/stats', readAuthHeaders(h.port));
    expect(res.statusCode).not.toBe(200);
  });
});
