/**
 * Recut of #4555 (RQ-PHX-DISKRUNWAYHOST52): the Host pane's disk runway route.
 * Drives the real fleet-control family handler (the route the desktop reaches) with the
 * default reader against a temp runs dir, so the dispatch, readFleetDiskForecast and the
 * runway arithmetic are all exercised — no injected reader.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { VERSE_FLEET_DISK_RUNWAY_PATH as PATH } from '../src/core/verse/fleet-disk-runway-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'recut68-runs-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

async function get() {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await handleFleetControlApi({ cfg: {} } as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: JSON.parse(text) };
}

describe('recut #4555: disk runway from the real runs-dir reader', () => {
  it('lives under the fleet-control family prefix', () => {
    expect(PATH).toBe('/api/verse/fleet/control/disk-runway');
  });

  it('projects hours to the reuse-only and hard-stop lines from disk-growth samples', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 7200;
    await mkdir(join(runsDir, 'queue'), { recursive: true });
    await mkdir(join(runsDir, 'metrics'), { recursive: true });
    // 283 GB -> 263 GB over two hours: 10 GB/h.
    await writeFile(join(runsDir, 'queue', 'disk-growth-history.json'),
      JSON.stringify([{ at: t0, free_gb: 283 }, { at: t0 + 7200, free_gb: 263 }]));
    await writeFile(join(runsDir, 'metrics', 'jobs.jsonl'), '');

    const r = await get();
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toMatchObject({ schema: 'fleet.disk-runway.v1', lines: { reuseOnlyGb: 100, hardStopGb: 30 } });
    expect(r.body.forecast).toMatchObject({ freeGb: 263, samples: 2 });
    expect(r.body.forecast.consumptionGbPerHour).toBeCloseTo(10, 6);
    expect(r.body.hoursToReuseOnly).toBeCloseTo(16.3, 6);
    expect(r.body.hoursToHardStop).toBeCloseTo(23.3, 6);
  });

  it('reports unknown, not a made-up runway, when the runs dir has no ledgers', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.forecast).toMatchObject({ status: 'unknown', freeGb: null });
    expect(r.body).toMatchObject({ hoursToReuseOnly: null, hoursToHardStop: null });
  });
});
