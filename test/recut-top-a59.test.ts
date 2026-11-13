// RQ-PHX-RECUTTOPA59: recut of #4567 (merge wait card). Drives the recovered
// GET /api/verse/fleet/merge-latency route over a real HTTP server, fed by
// events written through the real `phm fleet merge-latency --record` verb.
// Hermetic: the ledger lives in a temp dir injected into both entry points.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetMergeLatency } from '../src/cli/fleet-merge-latency.js';
import { createMergeLatencyApi, VERSE_MERGE_LATENCY_PATH } from '../src/core/verse/merge-latency-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { mergeWaitView } from '../src/web-ui/routes/verse/fleet-merges/merge-wait-model.js';

const NOW = Date.parse('2026-03-04T12:00:00Z');
const at = (min: number) => new Date(NOW - 3_600_000 + min * 60_000).toISOString();

let dir: string;
let server: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recut-top-a59-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

async function serve(ledgerPath: string): Promise<string> {
  const api = createMergeLatencyApi({ ledgerPath, now: () => NOW });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    void api({ cfg: {} } as VerseApiContext, req, res, path, req.method ?? 'GET').then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

it('serves stage waits for events recorded through the CLI verb', async () => {
  const ledgerPath = join(dir, 'merge-events.jsonl');
  const events = [
    { repo: 'fake/repo', pr: 11, type: 'opened', at: at(0) },
    { repo: 'fake/repo', pr: 11, type: 'queued', at: at(5) },
    { repo: 'fake/repo', pr: 11, type: 'checks_passed', at: at(25) },
    { repo: 'fake/repo', pr: 11, type: 'merged', at: at(26), head_sha: 'b'.repeat(40) },
  ];
  for (const event of events) {
    expect(await cmdFleetMergeLatency(['--events', ledgerPath, '--record', JSON.stringify(event)])).toBe(0);
  }
  const base = await serve(ledgerPath);

  const res = await fetch(`${base}${VERSE_MERGE_LATENCY_PATH}?hours=24`);
  expect(res.status).toBe(200);
  const body = await res.json() as { schema: string; ledger: string; report: { pr_stages: unknown[] } };
  expect(body).toMatchObject({ schema: 'verse.merge-latency.v1', ledger: 'present' });
  expect(body.report.pr_stages).toEqual([expect.objectContaining({ repo: 'fake/repo', pr: 11, queue_wait_s: 300, required_checks_s: 1200, merge_s: 60 })]);

  // The pane's model reads the same payload into the card the owner sees.
  const view = mergeWaitView(body);
  expect(view?.stages.map((s) => [s.key, s.medianS])).toEqual([['queue', 300], ['checks', 1200], ['merge', 60]]);
  expect(view?.verdict).toBe('Checks are the longest wait today');
});

it('answers missing, bad-input and write requests without touching the ledger', async () => {
  const base = await serve(join(dir, 'absent.jsonl'));
  const missing = await fetch(`${base}${VERSE_MERGE_LATENCY_PATH}`);
  expect(missing.status).toBe(200);
  expect(await missing.json()).toMatchObject({ ledger: 'missing', report: { known: false, window_hours: 24 } });
  expect((await fetch(`${base}${VERSE_MERGE_LATENCY_PATH}?hours=999`)).status).toBe(400);
  expect((await fetch(`${base}${VERSE_MERGE_LATENCY_PATH}`, { method: 'POST' })).status).toBe(405);
  expect((await fetch(`${base}/api/verse/fleet/other`)).status).toBe(404);
});
