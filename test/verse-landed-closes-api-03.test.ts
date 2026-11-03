import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import type { LandedClosesReport } from '../src/core/fleet/landed-closes-read.js';
import { createLandedClosesApi } from '../src/core/verse/landed-closes-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const report: LandedClosesReport = { v: 1, known: true, closed: 1, skipped: 0, failed: 0,
  rows: [{ at: '2026-11-02T17:00:00.000Z', pr: 42, outcome: 'closed' }] };
async function call(path: string, method: string) {
  const out = { status: 0, body: '' };
  const res = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.body = b ?? ''; },
    setHeader: () => {}, statusCode: 0 } as unknown as ServerResponse;
  let seen = 0;
  const handled = await createLandedClosesApi(async n => { seen = n; return report; }, () => now)(
    {} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, seen, ...out, json: out.body ? JSON.parse(out.body) : null };
}

it('returns the reader report on GET', async () => {
  const r = await call('/api/verse/fleet/landed-closes', 'GET');
  expect(r).toMatchObject({ handled: true, status: 200, seen: now, json: report });
});
it('answers 405 on POST and ignores other paths', async () => {
  expect(await call('/api/verse/fleet/landed-closes', 'POST')).toMatchObject({ handled: true, status: 405 });
  expect((await call('/api/verse/fleet/other', 'GET')).handled).toBe(false);
});
