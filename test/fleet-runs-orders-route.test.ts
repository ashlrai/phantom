import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/fleet/runs/orders';
let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'orders-route-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

async function call(method: string) {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = PATH;
  req.headers = {};
  let status = 0;
  let body = '';
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const api = createFleetRunsApi({ runsDir });
  expect(await api({} as VerseApiContext, req, res, PATH, method)).toBe(true);
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

it('GET returns the orders view shape', async () => {
  const { status, body } = await call('GET');
  expect(status).toBe(200);
  expect(body).toMatchObject({ v: 1, items: [], summary: { sourceQuality: 'missing' } });
  expect(typeof body['observedAt']).toBe('string');
});

it('rejects other methods with 405', async () => {
  expect((await call('POST')).status).toBe(405);
});
