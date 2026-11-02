/**
 * RQ-PHX-SELFTICKRUNNOW02 — POST /api/verse/fleet/self-tick: one locked
 * self-tick pass run in the server process for the desktop Needs-you row.
 * The route is gated like every Verse mutation (404 without dispatch, the
 * x-ashlr-token + JSON Content-Type gate, a JSON-object body, no query
 * parameters), runs one pass at a time, and answers the parsed report.
 * The runTick seam is injected — these tests never run the real verbs.
 * Everything runs against a temp dir under os.tmpdir(), never ~/.ashlr-runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFleetSelfTickApi,
  VERSE_FLEET_SELF_TICK_PATH as PATH,
  type FleetSelfTickRunResult,
} from '../src/core/verse/fleet-self-tick-api.js';
import { writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import type { SelfTickReport } from '../src/core/fleet/self-tick.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { handleVerseApi, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';

const RAN: SelfTickReport = {
  v: 1, at: '2026-11-01T12:00:00Z', mode: 'apply', state: 'ran',
  steps: [
    { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
    { step: 'lane-autohold', state: 'ok', exitCode: 0, report: null },
    { step: 'planner-tick', state: 'ok', exitCode: 0, report: null },
  ],
};
const BUSY: SelfTickReport = { v: 1, at: RAN.at, mode: 'apply', state: 'busy', steps: [] };
const FAILED: SelfTickReport = {
  ...RAN, steps: [{ step: 'planner-tick', state: 'failed', exitCode: 1, report: null }],
};

interface CallOpts {
  token?: string; allowDispatch?: boolean; contentType?: string;
  rawBody?: string; url?: string; method?: string;
}

async function call(api: ApiModule, body: unknown = { apply: true }, opts: CallOpts = {}) {
  const method = opts.method ?? 'POST';
  const url = opts.url ?? PATH;
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, {
    method, url,
    headers: { 'content-type': opts.contentType ?? 'application/json', 'x-ashlr-token': opts.token ?? 'fixture-token' },
  });
  req.end(opts.rawBody ?? (body === undefined ? '' : JSON.stringify(body)));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: opts.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : null, payload };
}

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'self-tick-run-')); });
afterEach(() => { setMountedApiModulesForTest(null); rmSync(runsDir, { recursive: true, force: true }); });

const ok = () => vi.fn(async () => ({ exitCode: 0, report: RAN }));
const api = (runTick?: (args: string[]) => Promise<FleetSelfTickRunResult>) =>
  createFleetSelfTickApi({ runsDir, runTick });

describe('POST /api/verse/fleet/self-tick', () => {
  it('answers 404 without dispatch and never runs', async () => {
    const runTick = ok();
    expect(await call(api(runTick), { apply: true }, { allowDispatch: false }))
      .toMatchObject({ handled: true, status: 404 });
    expect(runTick).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong mutation token and a non-JSON content type', async () => {
    const runTick = ok();
    const handler = api(runTick);
    expect((await call(handler, { apply: true }, { token: '' })).status).toBe(401);
    expect((await call(handler, { apply: true }, { token: 'wrong' })).status).toBe(401);
    expect((await call(handler, { apply: true }, { contentType: 'text/plain' })).status).toBe(415);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('rejects a bad body, a non-boolean apply, unknown keys and query parameters', async () => {
    const runTick = ok();
    const handler = api(runTick);
    for (const bad of [[1], 'x', { apply: 'yes' }, { apply: 1 }, { apply: true, extra: 1 }, { other: true }]) {
      expect((await call(handler, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(handler, undefined, { rawBody: '{oops' })).status).toBe(400);
    expect((await call(handler, { apply: true }, { url: `${PATH}?apply=true` })).status).toBe(400);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('passes --apply to the seam only when apply is true, always --json and --runs-dir', async () => {
    const runTick = ok();
    const handler = api(runTick);
    expect((await call(handler, { apply: true })).status).toBe(200);
    expect(runTick).toHaveBeenLastCalledWith(['--json', '--apply', '--runs-dir', runsDir]);
    await call(handler, {});
    expect(runTick).toHaveBeenLastCalledWith(['--json', '--runs-dir', runsDir]);
    await call(handler, { apply: false });
    expect(runTick).toHaveBeenLastCalledWith(['--json', '--runs-dir', runsDir]);
    expect(runTick).toHaveBeenCalledTimes(3);
  });

  it('answers 200 with the parsed report — busy and step-failed are not request errors', async () => {
    expect(await call(api(ok()))).toMatchObject({ status: 200, body: { v: 1, exitCode: 0, report: RAN } });
    const busy = api(vi.fn(async () => ({ exitCode: 0, report: BUSY })));
    expect(await call(busy)).toMatchObject({ status: 200, body: { v: 1, exitCode: 0, report: BUSY } });
    const failed = api(vi.fn(async () => ({ exitCode: 1, report: FAILED })));
    expect(await call(failed)).toMatchObject({ status: 200, body: { v: 1, exitCode: 1, report: FAILED } });
  });

  it('answers 409 busy to a second POST while a run is in flight', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const runTick = vi.fn(async (): Promise<FleetSelfTickRunResult> => {
      await gate;
      return { exitCode: 0, report: RAN };
    });
    const handler = api(runTick);
    const first = call(handler);
    expect(await call(handler)).toMatchObject({ status: 409, body: { code: 'busy' } });
    expect(runTick).toHaveBeenCalledTimes(1);
    finish();
    expect((await first).status).toBe(200);
  });

  it('maps a thrown run to 503 with a fixed message and no path text', async () => {
    const handler = api(vi.fn(async () => { throw new Error(`${join(runsDir, 'do-not-leak')} exploded`); }));
    const result = await call(handler);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ v: 1, error: 'fleet self-tick unavailable' });
    expect(result.payload).not.toContain(runsDir);
  });

  it('leaves GET read-only: the seam is never called', async () => {
    const runTick = ok();
    writeSelfTickLast(runsDir, RAN);
    const result = await call(api(runTick), undefined, { method: 'GET' });
    expect(result.status).toBe(200);
    expect(result.body?.['last']).toMatchObject({ state: 'ok', ranState: 'ran' });
    expect(runTick).not.toHaveBeenCalled();
  });

  it('reaches the module through the real verse dispatcher', async () => {
    const runTick = ok();
    setMountedApiModulesForTest([{ id: 'fleet-self-tick', load: async () => api(runTick) }]);
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, {
      method: 'POST', url: PATH,
      headers: { 'content-type': 'application/json', 'x-ashlr-token': 'fixture-token' },
    });
    req.end(JSON.stringify({ apply: true }));
    let status = 0, payload = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { payload = chunk ?? ''; return this; },
    } as unknown as ServerResponse;
    const ctx = { token: 'fixture-token', allowDispatch: true } as VerseApiContext;
    expect(await handleVerseApi(ctx, req, res, PATH, 'POST')).toBe(true);
    expect(status).toBe(200);
    expect(JSON.parse(payload)).toMatchObject({ v: 1, exitCode: 0 });
    expect(runTick).toHaveBeenCalledWith(['--json', '--apply', '--runs-dir', runsDir]);
  });
});
