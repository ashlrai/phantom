import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createFleetDiskForecastApi } from '../src/core/verse/fleet-disk-forecast-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const result = { schema: 'fleet.mcp.disk-forecast.v1' as const, advice: 'ok' as const,
  forecast: { schema: 'fleet.disk-forecast.v1', status: 'unknown', thresholdGb: 150, samples: 0 } as never };
async function call(api: ReturnType<typeof createFleetDiskForecastApi>, method = 'GET') {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(v: string) { text = v; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/disk-forecast', method);
  expect(handled).toBe(true);
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}
it('serves the stubbed result with v:1', async () => {
  const read = vi.fn(async () => result);
  const out = await call(createFleetDiskForecastApi({ read, now: () => 0, runsDir: '/x' }));
  expect(out.status).toBe(200);
  expect(out.body).toMatchObject({ v: 1, generatedAt: '1970-01-01T00:00:00.000Z', ...result });
  expect(read).toHaveBeenCalledWith('/x');
});
it('405s non-GET and ignores other paths', async () => {
  const api = createFleetDiskForecastApi({ read: vi.fn(async () => result) });
  expect((await call(api, 'POST')).status).toBe(405);
  expect(await api({} as VerseApiContext, {} as IncomingMessage, {} as ServerResponse, '/other', 'GET')).toBe(false);
});
it('reports unavailable when the reader throws', async () => {
  const out = await call(createFleetDiskForecastApi({ read: async () => { throw new Error('/secret/path'); } }));
  expect(out).toEqual({ status: 200, body: { v: 1, unavailable: true } });
});
it('caches for 30 s', async () => {
  let t = 0;
  const read = vi.fn(async () => result);
  const api = createFleetDiskForecastApi({ read, now: () => t });
  await call(api); t = 29_999; await call(api);
  expect(read).toHaveBeenCalledTimes(1);
  t = 30_000; await call(api);
  expect(read).toHaveBeenCalledTimes(2);
});
