/**
 * verse/slow-prs-api.ts — GET /api/verse/fleet/slow-prs. The handler is invoked
 * directly with an injected ledger reader; the >2 MiB case uses a real temp
 * file through the default bounded tail read.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { FleetSlowPrsReader } from '../src/cli/fleet-slow-prs.js';
import { createSlowPrsApi, VERSE_SLOW_PRS_PATH as PATH } from '../src/core/verse/slow-prs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = Date.parse('2026-11-04T18:00:00Z');
const ledger = [
  JSON.stringify({ class: 'pr', url: 'https://github.com/example/demo/pull/7', ts: '2026-11-04T00:00:00Z' }),
  JSON.stringify({ class: 'pr', url: 'https://github.com/example/two/pull/3', ts: '2026-11-04T00:05:00Z' }),
  JSON.stringify({ job: 'j1', ts: '2026-11-04T01:00:00Z' }),
].join('\n');

async function call(opts: { read?: FleetSlowPrsReader; runsDir?: string; path?: string; method?: string; url?: string } = {}) {
  const out = { status: 0, body: '' };
  const res = {
    writeHead: (s: number) => { out.status = s; },
    end: (b?: string) => { out.body = b ?? ''; },
    setHeader: () => {},
    statusCode: 0,
  } as unknown as ServerResponse;
  const req = { url: opts.url ?? opts.path ?? PATH } as IncomingMessage;
  const handled = await createSlowPrsApi(opts.read, () => now, opts.runsDir)(
    {} as VerseApiContext, req, res, opts.path ?? PATH, opts.method ?? 'GET');
  return { handled, ...out, json: out.body ? (JSON.parse(out.body) as Record<string, unknown>) : null };
}

it('returns known:true with repos grouped from the ledger', async () => {
  const r = await call({ read: async () => ledger });
  expect(r.handled).toBe(true);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({
    known: true, schema: 'fleet.slow-prs.v1', readOnly: true,
    repos: [
      { repo: 'example/demo', count: 1, urls: ['https://github.com/example/demo/pull/7'] },
      { repo: 'example/two', count: 1, urls: ['https://github.com/example/two/pull/3'] },
    ],
  });
});

it('serves known:false with status 200 when the reader throws, without error text', async () => {
  const r = await call({ read: async () => { throw new Error('/private/jobs.jsonl gone'); } });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ known: false, repos: [] });
  expect(r.body).not.toContain('private');
});

it('answers 405 on POST and 400 on a query parameter', async () => {
  expect((await call({ read: async () => ledger, method: 'POST' })).status).toBe(405);
  const bad = await call({ read: async () => ledger, url: `${PATH}?x=1` });
  expect(bad.status).toBe(400);
  expect(bad.json).toMatchObject({ code: 'VERSE_INVALID' });
});

it('returns false for other paths', async () => {
  expect((await call({ read: async () => ledger, path: '/api/verse/fleet/other' })).handled).toBe(false);
});

it('tail-reads only the last 2 MiB of a larger ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verse-slow-prs-'));
  try {
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    const head = JSON.stringify({ class: 'pr', url: 'https://github.com/example/head/pull/1', ts: '2026-11-04T00:00:00Z' });
    const tail = JSON.stringify({ class: 'pr', url: 'https://github.com/example/tail/pull/2', ts: '2026-11-04T00:00:00Z' });
    const newest = JSON.stringify({ job: 'j1', ts: '2026-11-04T01:00:00Z' });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), [head, 'x'.repeat(3 * 1024 * 1024), tail, newest].join('\n'));
    const r = await call({ runsDir: dir });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      known: true,
      repos: [{ repo: 'example/tail', count: 1, urls: ['https://github.com/example/tail/pull/2'] }],
    });
    expect(r.body).not.toContain('example/head');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
