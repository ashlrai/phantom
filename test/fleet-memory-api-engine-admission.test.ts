/** GET /api/verse/fleet/memory — engine launch gate verdict in the memory feed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetMemoryApi, VERSE_FLEET_MEMORY_PATH as PATH } from '../src/core/verse/fleet-memory-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { ENGINE_ADMISSION_THRESHOLDS, type EngineAdmissionView } from '../src/core/fleet/engine-admission-view.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function call(api: ApiModule, url = PATH, method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const TS_SECONDS = 1793589510;
const NOW = TS_SECONDS * 1000 + 30_000;
const MEMSTAT = { schema: 'ashlr.memstat.v1', ts: TS_SECONDS, free_pct: 58, swap_gb: 0, swapouts_per_min: 0, disk_gb: 601 };

const ADMISSION: EngineAdmissionView = {
  gated: true, allowed: false, free_pct: 12.3, swap_gb: 9.87,
  reason: 'Host memory pressure: 12.3% free, 9.87 GiB swap; launch held until at least 35% free and at most 6 GiB swap.',
  thresholds: ENGINE_ADMISSION_THRESHOLDS,
};

describe('fleet memory engine_admission field', () => {
  it('serves the injected admission verdict inside the memory view', async () => {
    const readAdmission = vi.fn(() => ADMISSION);
    const api = createFleetMemoryApi({
      readFiles: async () => ({ memstat: MEMSTAT, memguard: null }),
      runsDir: '/runs-root', now: () => NOW, readAdmission,
    });
    const result = await call(api);
    expect(result.status).toBe(200);
    expect(readAdmission).toHaveBeenCalledTimes(1);
    expect(result.body).toMatchObject({ v: 1, generatedAt: new Date(NOW).toISOString() });
    expect(result.body.memory.schema).toBe('fleet.memory.v1');
    expect(result.body.memory.engine_admission).toEqual(ADMISSION);
    expect(result.body.memory.sample).toMatchObject({ free_pct: 58, swap_gb: 0 });
  });

  it('reports a not-gated platform without touching sample fields', async () => {
    const api = createFleetMemoryApi({
      readFiles: async () => ({ memstat: MEMSTAT, memguard: null }),
      runsDir: '/runs-root', now: () => NOW,
      readAdmission: () => ({
        gated: false, allowed: null, free_pct: null, swap_gb: null,
        reason: 'Engine memory gate runs on macOS only.', thresholds: ENGINE_ADMISSION_THRESHOLDS,
      }),
    });
    const result = await call(api);
    expect(result.status).toBe(200);
    expect(result.body.memory.engine_admission).toMatchObject({ gated: false, allowed: null });
    expect(result.body.memory.sample.free_pct).toBe(58);
  });
});
