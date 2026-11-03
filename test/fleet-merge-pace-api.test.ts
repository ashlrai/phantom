/** verse/fleet-merge-pace-api.ts — GET /api/verse/fleet/merge-pace, invoked directly with injected deps. */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createFleetMergePaceApi, VERSE_FLEET_MERGE_PACE_PATH as PATH } from '../src/core/verse/fleet-merge-pace-api.js';
import { fleetMergePace } from '../src/core/fleet/merge-pace.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const ledger = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'a', ts: new Date(now - 3_600_000).toISOString(),
  url: 'https://github.com/o/one/pull/1', ttm_s: 30 });
const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;

async function call(method: string, url = PATH, read: () => Promise<string | null> = async () => ledger) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createFleetMergePaceApi({ read, now: () => now })(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? JSON.parse(payload) : null };
}

it('serves exactly the `fleet merge-pace --json` report', async () => {
  const result = await call('GET');
  expect(result.status).toBe(200);
  expect(result.json).toEqual(await fleetMergePace(async () => ledger, now));
  expect(result.json.rows[0]).toEqual({ repo: 'o/one', merges: 1, merges_per_hour: 1 / 6, median_ttm_s: 30 });
});

it('answers known:false with null rows when the ledger is unreadable', async () => {
  const result = await call('GET', PATH, async () => null);
  expect(result.status).toBe(200);
  expect(result.json).toEqual({ schema: 'fleet.merge-pace.v1', known: false, window_hours: 6, rows: null });
});

it('rejects other methods and unknown parameters, and declines other paths', async () => {
  expect((await call('POST')).status).toBe(405);
  expect((await call('GET', `${PATH}?hours=1`)).status).toBe(400);
  const other = await call('GET', '/api/verse/fleet/other');
  expect(other.handled).toBe(false);
});
