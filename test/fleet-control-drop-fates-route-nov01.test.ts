import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const path = '/api/verse/fleet/control/drop-fates';
afterEach(() => vi.unstubAllEnvs());
async function call(query = '', method = 'GET') {
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { payload = body; } } as unknown as ServerResponse;
  await handleFleetControlApi({} as VerseApiContext, { url: path + query } as IncomingMessage, res, path, method);
  return { status, body: JSON.parse(payload) };
}
it('returns a missing empty report with 200', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fates-route-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  try { expect(await call('?limit=50')).toMatchObject({ status: 200, body: { v: 1, generatedAt: expect.any(String), sourceState: 'missing', fates: [] } }); }
  finally { await rm(root, { recursive: true }); }
});
it('rejects invalid limits and unexpected or repeated parameters', async () => {
  for (const query of ['?limit=0', '?limit=51', '?limit=1.5', '?limit=no', '?limit=', '?extra=1', '?limit=2&limit=3']) expect((await call(query)).status).toBe(400);
});
it('rejects other methods', async () => { for (const method of ['POST', 'DELETE', 'PUT']) expect((await call('', method)).status).toBe(405); });
