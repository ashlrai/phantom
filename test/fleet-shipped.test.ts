import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { readFleetShipped, SHIPPED_REPOS } from '../src/core/fleet/shipped.js';
import { cmdShipped } from '../src/cli/shipped.js';
import { handleShippedApi } from '../src/core/verse/whats-new-api.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const fixture = readFileSync(new URL('./fixtures/shipped/fleet-day.json', import.meta.url), 'utf8');
const deps = { now, gh: async () => fixture, read: async (_: string, add: (line: string) => void) => {
  add(JSON.stringify({ repo: 'phantom', job: 'RQ-SHIPPED-PANEL', pool: 'codex-personal' })); return true;
} };
it('groups recorded PRs across repositories, extracts body jobs, joins lanes and calculates totals', async () => {
  const report = await readFleetShipped(deps);
  expect(Object.keys(report.byRepo)).toEqual(SHIPPED_REPOS);
  expect(report.byRepo).toMatchObject({ 'ashlrai/phantom': 2, 'ashlrai/locus': 1, 'ashlrai/lexicon': 0 });
  expect(report.items.map(pr => pr.number)).toEqual([7, 4, 8]);
  expect(report.items[0]).toMatchObject({ jobId: 'RQ-SHIPPED-PANEL', lane: 'codex-personal', openToMergeSeconds: 82800 });
  expect(report.items[2]).toMatchObject({ jobId: null, lane: null });
  expect(report.items[1]).toMatchObject({ jobId: 'RQ-ACCESS-DOCS', lane: null });
  expect(report.totals).toEqual({ merged: 3, mergedPerHour: 0.125, medianOpenToMergeSeconds: 7200 });
});
it('distinguishes a recorded empty day from a failed or incomplete search', async () => {
  const empty = JSON.stringify({ total_count: 0, incomplete_results: false, items: [] });
  expect((await readFleetShipped({ ...deps, gh: async () => empty })).totals).toEqual({ merged: 0, mergedPerHour: 0, medianOpenToMergeSeconds: null });
  for (const gh of [async () => empty.replace('false', 'true'), async () => { throw Error('unavailable'); }]) {
    expect((await readFleetShipped({ ...deps, gh })).totals).toEqual({ merged: null, mergedPerHour: null, medianOpenToMergeSeconds: null });
  }
});
it('serves identical typed CLI and HTTP reports and refuses invalid feed parameters', async () => {
  const fleet = () => readFleetShipped(deps), out: string[] = [];
  expect(await cmdShipped(['--since', '24h', '--json'], { fleet, out: text => out.push(text) })).toBe(0);
  let status = 0, body: unknown;
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { body = JSON.parse(text); } } as unknown as ServerResponse;
  await handleShippedApi({ url: '/api/verse/shipped?since=24h' } as IncomingMessage, res, 'GET', { fleet });
  expect(status).toBe(200); expect(body).toEqual(JSON.parse(out[0]!));
  await handleShippedApi({ url: '/api/verse/shipped?since=oops' } as IncomingMessage, res, 'GET', { fleet });
  expect(status).toBe(400);
});
