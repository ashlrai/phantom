/** GET /api/verse/fleet/disk-runway — the Host pane's disk runway feed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { diskForecast, type DiskForecast } from '../src/core/fleet/disk-forecast.js';
import { createFleetDiskRunwayApi, hoursToLine, VERSE_FLEET_DISK_RUNWAY_PATH as PATH } from '../src/core/verse/fleet-disk-runway-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function call(api: ApiModule, method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}
const forecast = (freeGb: number | null, rate: number | null): DiskForecast =>
  ({ ...diskForecast(null, null), status: 'projected', freeGb, consumptionGbPerHour: rate });
const serve = (f: DiskForecast) => call(createFleetDiskRunwayApi({ readForecast: async () => ({ forecast: f }) }));

describe('hoursToLine', () => {
  it('divides the distance to the line by the rate', () => {
    expect(hoursToLine(300, 10, 100)).toBe(20);
    expect(hoursToLine(130, 10, 100)).toBe(3);
  });
  it('is 0 at or below the line, whatever the rate', () => {
    expect(hoursToLine(100, 10, 100)).toBe(0);
    expect(hoursToLine(56, 10, 100)).toBe(0);
    expect(hoursToLine(56, null, 100)).toBe(0);
    expect(hoursToLine(56, -5, 100)).toBe(0);
  });
  it('is null above the line without a falling rate', () => {
    expect(hoursToLine(300, 0, 100)).toBeNull();
    expect(hoursToLine(300, -2, 100)).toBeNull();
    expect(hoursToLine(300, null, 100)).toBeNull();
    expect(hoursToLine(null, 10, 100)).toBeNull();
  });
});

describe('fleet disk runway route', () => {
  it('returns both lines and hours for a falling disk', async () => {
    const r = await serve(forecast(283, 10));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'fleet.disk-runway.v1', lines: { reuseOnlyGb: 100, hardStopGb: 30 },
      hoursToReuseOnly: 18.3, hoursToHardStop: 25.3 });
  });
  it('is 0 for the line already crossed and counts down the other', async () => {
    const r = await serve(forecast(56, 2));
    expect(r.body).toMatchObject({ hoursToReuseOnly: 0, hoursToHardStop: 13 });
  });
  it('is null for both when the rate is not falling', async () => {
    const r = await serve(forecast(283, -1));
    expect(r.body).toMatchObject({ hoursToReuseOnly: null, hoursToHardStop: null });
  });
  it('answers 405 to non-GET', async () => {
    const r = await call(createFleetDiskRunwayApi({ readForecast: async () => ({ forecast: forecast(1, 1) }) }), 'POST');
    expect(r).toMatchObject({ handled: true, status: 405 });
  });
  it('ignores other paths', async () => {
    const api = createFleetDiskRunwayApi();
    const req = Object.assign(new PassThrough(), { url: '/x', method: 'GET' }) as IncomingMessage;
    expect(await api({ cfg: {} } as VerseApiContext, req, {} as ServerResponse, '/x', 'GET')).toBe(false);
  });
  it('returns 200 with unknown status when the reader throws', async () => {
    const r = await call(createFleetDiskRunwayApi({ readForecast: async () => { throw new Error('/secret/path'); } }));
    expect(r.status).toBe(200);
    expect(r.body.forecast.status).toBe('unknown');
    expect(r.body).toMatchObject({ hoursToReuseOnly: null, hoursToHardStop: null });
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});
