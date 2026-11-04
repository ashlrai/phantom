/** GET /api/verse/fleet/memory — the Host pane's memory-guard feed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetMemoryApi, VERSE_FLEET_MEMORY_PATH as PATH } from '../src/core/verse/fleet-memory-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { mountedApiModules, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { EngineAdmissionView } from '../src/core/fleet/engine-admission-view.js';

// The default loader must never sample the real vm_stat/sysctl inside a test.
vi.mock('../src/core/fleet/engine-admission-view.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/fleet/engine-admission-view.js')>();
  return { ...mod, readEngineAdmission: () => mod.engineAdmissionView({ freePercent: 61, swapGb: 0.5 }, 'darwin') };
});

async function call(api: ApiModule, url = PATH, method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: text ? JSON.parse(text) : null, text };
}

const TS_SECONDS = 1793589510;
const NOW = TS_SECONDS * 1000 + 30_000;
const MEMSTAT = { schema: 'ashlr.memstat.v1', ts: TS_SECONDS, free_pct: 58, swap_gb: 0, swapouts_per_min: 0, disk_gb: 601 };
const MEMGUARD = { stopped: { '4242': 'RQ-PHX-A' }, calm: 8, omlx_down: false };
const ADMISSION: EngineAdmissionView = {
  gated: true, allowed: true, free_pct: 61, swap_gb: 0.5, reason: null,
  thresholds: { hold_below_free_pct: 30, hold_above_swap_gb: 8, resume_free_pct: 35, resume_swap_gb: 6 },
};

describe('fleet memory read route', () => {
  it('returns the projected memory view for the injected files', async () => {
    const readFiles = vi.fn(async () => ({ memstat: MEMSTAT, memguard: MEMGUARD }));
    const readAdmission = vi.fn(() => ADMISSION);
    const result = await call(createFleetMemoryApi({ readFiles, readAdmission, runsDir: '/runs-root', now: () => NOW }));
    expect(readFiles).toHaveBeenCalledWith('/runs-root');
    expect(readAdmission).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      v: 1,
      generatedAt: new Date(NOW).toISOString(),
      memory: {
        schema: 'fleet.memory.v1',
        generatedAt: new Date(NOW).toISOString(),
        sample: {
          free_pct: 58, swap_gb: 0, swapouts_per_min: 0, disk_gb: 601,
          sampled_at: new Date(TS_SECONDS * 1000).toISOString(), age_ms: 30_000, stale: false,
        },
        memguard: { level: null, stopped: ['RQ-PHX-A'], omlx_down: false, calm: 8 },
        engine_admission: ADMISSION,
      },
    });
  });

  it('declines non-GET methods and foreign paths without reading', async () => {
    const readFiles = vi.fn();
    const api = createFleetMemoryApi({ readFiles });
    expect(await call(api, PATH, 'POST')).toMatchObject({ handled: false, status: 404 });
    expect(await call(api, PATH, 'HEAD')).toMatchObject({ handled: false });
    expect((await call(api, '/api/verse/fleet/usage-audit')).handled).toBe(false);
    expect(readFiles).not.toHaveBeenCalled();
  });

  it('answers 503 with a fixed message when the read throws, without echoing it', async () => {
    const result = await call(createFleetMemoryApi({ readFiles: async () => { throw new Error('/private/runs/path'); } }));
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ v: 1, error: 'fleet memory unavailable' });
    expect(result.text).not.toContain('/private');
  });

  it('is mounted beside fleet-usage-audit and answers through the default loader', async () => {
    setMountedApiModulesForTest(null);
    const ids = mountedApiModules().map((m) => m.id);
    expect(ids.indexOf('fleet-memory')).toBe(ids.indexOf('fleet-usage-audit') + 1);
    const entry = mountedApiModules().find((m) => m.id === 'fleet-memory')!;
    const result = await call(await entry.load());
    expect(result.status).toBe(200);
    expect(result.body.v).toBe(1);
    expect(result.body.memory.schema).toBe('fleet.memory.v1');
    expect(result.body.memory.engine_admission).toMatchObject({ gated: true, allowed: true, free_pct: 61 });
  });
});
