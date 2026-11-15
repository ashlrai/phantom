/**
 * RQ-PHX-RECUTDESKS0C219 — recovered #4846 merge-wait surface, proven at the
 * server boundary: GET /api/verse/fleet/merge-latency is served by the
 * mergeLatencyApi module the composition root injects into handleApi (the same
 * inline ctx pattern the fleet board uses, since the mounted module table is
 * contract-frozen). Covers: delegation with query string intact, 503 when the
 * module is not wired, 404 for child paths, and the module's own 405 on POST.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { handleApi } from '../src/core/web/api.js';
import { createMergeLatencyApi } from '../src/core/verse/merge-latency-api.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');
const PATH = '/api/verse/fleet/merge-latency';
const cfg = { version: 1, roots: [], telemetry: {}, tools: {}, models: { providerChain: [] } } as never;
const session = { id: 'desk-recut-s0-c219', expiresAt: Date.now() + 3_600_000 };

async function call(url: string, method = 'GET', mergeLatencyApi?: ReturnType<typeof createMergeLatencyApi>) {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1' };
  let status = 0;
  let text = '';
  const res = Object.assign(new EventEmitter(), {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    write(chunk: string) { text += chunk; return true; },
    end(chunk?: string) { if (chunk) text += chunk; },
  }) as unknown as ServerResponse;
  const handled = await handleApi(req, res, cfg, {
    token: 't',
    allowDispatch: false,
    readSession: session,
    ...(mergeLatencyApi ? { mergeLatencyApi } : {}),
  });
  return { status, handled, body: text ? JSON.parse(text) : null };
}

function ledger(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-recut-c219-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'merge-events.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

it('serves the merge-latency report through the injected module', async () => {
  const at = (min: number) => new Date(NOW - 3_600_000 + min * 60_000).toISOString();
  const ledgerPath = ledger([
    { repo: 'fake/repo', pr: 7, type: 'opened', at: at(0) },
    { repo: 'fake/repo', pr: 7, type: 'queued', at: at(3) },
    { repo: 'fake/repo', pr: 7, type: 'checks_passed', at: at(9) },
    { repo: 'fake/repo', pr: 7, type: 'merged', at: at(11) },
  ]);
  const api = createMergeLatencyApi({ ledgerPath, now: () => NOW });
  const { status, handled, body } = await call(`${PATH}?hours=6`, 'GET', api);
  expect(handled).toBe(true);
  expect(status).toBe(200);
  expect(body).toMatchObject({ schema: 'verse.merge-latency.v1', ledger: 'present' });
  expect(body.report.window_hours).toBe(6);
  expect(body.report.pr_stages).toEqual([expect.objectContaining({ pr: 7, queue_wait_s: 180, required_checks_s: 360, merge_s: 120 })]);
});

it('503s when the composition root did not wire the module', async () => {
  const { status, handled } = await call(`${PATH}?hours=24`);
  expect(handled).toBe(true);
  expect(status).toBe(503);
});

it('404s child paths instead of delegating', async () => {
  const spy = vi.fn(createMergeLatencyApi({ ledgerPath: '/nope' }));
  const { status } = await call(`${PATH}/extra`, 'GET', spy);
  expect(status).toBe(404);
  expect(spy).not.toHaveBeenCalled();
});

it('the module itself rejects POST with 405', async () => {
  const api = createMergeLatencyApi({ ledgerPath: '/nope' });
  const { status } = await call(PATH, 'POST', api);
  expect(status).toBe(405);
});
