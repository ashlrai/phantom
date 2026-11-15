import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createMergeLatencyApi, VERSE_MERGE_LATENCY_PATH as PATH } from '../src/core/verse/merge-latency-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');
const SHA = 'a'.repeat(40);

async function call(api: ApiModule, query = '', method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH + query, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, setHeader() { return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, PATH, method);
  return { status, handled, body: text ? JSON.parse(text) : null };
}
const ledger = (lines: object[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-latency-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'merge-events.jsonl');
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
};
const at = (min: number) => new Date(NOW - 3_600_000 + min * 60_000).toISOString();

it('returns the report for a temp ledger', async () => {
  const ledgerPath = ledger([
    { repo: 'fake/repo', pr: 7, type: 'opened', at: at(0) },
    { repo: 'fake/repo', pr: 7, type: 'queued', at: at(2) },
    { repo: 'fake/repo', pr: 7, type: 'checks_passed', at: at(12) },
    { repo: 'fake/repo', pr: 7, type: 'merged', at: at(13), head_sha: SHA },
  ]);
  const { status, body } = await call(createMergeLatencyApi({ ledgerPath, now: () => NOW }), '?hours=6');
  expect(status).toBe(200);
  expect(body).toMatchObject({ schema: 'verse.merge-latency.v1', generatedAt: new Date(NOW).toISOString(), ledger: 'present' });
  expect(body.report.window_hours).toBe(6);
  expect(body.report.pr_stages).toEqual([expect.objectContaining({ pr: 7, queue_wait_s: 120, required_checks_s: 600, merge_s: 60 })]);
});

it('reports a missing ledger as missing, not an error', async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'merge-latency-')), 'absent.jsonl');
  const { status, body } = await call(createMergeLatencyApi({ ledgerPath, now: () => NOW }));
  expect(status).toBe(200);
  expect(body.ledger).toBe('missing');
  expect(body.report).toMatchObject({ known: false, pr_stages: null, window_hours: 24 });
});

it.each(['?hours=0', '?hours=169', '?hours=abc', '?hours=1.5', '?hours=-3', '?hours='])('400 on bad hours %s', async query => {
  expect((await call(createMergeLatencyApi({ ledgerPath: '/nope' }), query)).status).toBe(400);
});

it('405 on POST', async () => {
  expect(await call(createMergeLatencyApi({ ledgerPath: '/nope' }), '', 'POST')).toMatchObject({ status: 405, handled: true });
});

it('a request cannot choose the ledger path', async () => {
  const reader = vi.fn(() => async () => null);
  await call(createMergeLatencyApi({ ledgerPath: '/fixed/merge-events.jsonl', reader }), '?path=/etc/passwd&events=/etc/hosts&hours=2');
  expect(reader).toHaveBeenCalledTimes(1);
  expect(reader).toHaveBeenCalledWith('/fixed/merge-events.jsonl');
});

it('ignores other paths and is mounted', async () => {
  const api = createMergeLatencyApi();
  const req = Object.assign(new PassThrough(), { url: '/x', method: 'GET' }) as IncomingMessage;
  expect(await api({ cfg: {} } as VerseApiContext, req, {} as ServerResponse, '/api/verse/fleet/other', 'GET')).toBe(false);
  expect(WORKBENCH_ROUTE_FAMILIES.some(f => f.id === 'fleet-merge-latency' && f.handler === 'handleMergeLatencyApi')).toBe(true);
});
