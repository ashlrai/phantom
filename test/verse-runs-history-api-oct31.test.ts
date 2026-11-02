/**
 * verse/runs-history-api.ts — GET /api/verse/runs-history. The handler is
 * invoked directly with injected deps; no server, no real files.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunsHistoryApi,
  VERSE_RUNS_HISTORY_PATH as PATH,
  type RunsHistoryApiDeps,
} from '../src/core/verse/runs-history-api.js';
import type { RunsHistory, RunsSample } from '../src/core/fleet/runs-history.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const AT = '2026-10-31T12:00:00.000Z';
const series: RunsHistory = {
  v: 1, generatedAt: AT, from: '2026-10-30T12:00:00.000Z', to: AT,
  sourceState: 'healthy', dropped: 0,
  samples: [{ at: AT, lanes: [{ lane: 'fake-lane', running: 1, target: 2, queued: 3, held: false }], workers: 4, leaders: 1, paused: false } satisfies RunsSample],
};
const deps = (): Required<RunsHistoryApiDeps> => ({
  sample: vi.fn(async () => true),
  readHistory: vi.fn(async () => series),
});
const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;

async function call(method: string, url = PATH, d = deps()) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createRunsHistoryApi(d)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null, deps: d };
}

describe('GET /api/verse/runs-history', () => {
  it('returns the stored series for the default 24h window after offering a sample', async () => {
    const result = await call('GET');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(series);
    expect(result.deps.sample).toHaveBeenCalledOnce();
    expect(result.deps.readHistory).toHaveBeenCalledWith(24);
  });

  it('passes a valid ?hours= through to the reader', async () => {
    const result = await call('GET', `${PATH}?hours=48`);
    expect(result.status).toBe(200);
    expect(result.deps.readHistory).toHaveBeenCalledWith(48);
  });

  it.each([`${PATH}?hours=0`, `${PATH}?hours=999`, `${PATH}?hours=x`])('rejects %s with 400', async (url) => {
    const result = await call('GET', url);
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({ code: 'VERSE_INVALID' });
    expect(result.deps.readHistory).not.toHaveBeenCalled();
  });

  it('rejects unknown query parameters', async () => {
    const result = await call('GET', `${PATH}?bogus=1`);
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('answers 405 for other methods on the path and false for other paths', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('DELETE')).status).toBe(405);
    expect((await call('GET', '/api/verse/runs-history/extra')).handled).toBe(false);
    expect((await call('GET', '/api/verse/other')).handled).toBe(false);
  });

  it('still serves the series when sampling throws', async () => {
    const d = deps();
    d.sample.mockRejectedValue(new Error('sampler broke'));
    const result = await call('GET', PATH, d);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(series);
  });

  it('reports a reader failure as a fixed-message 500', async () => {
    const d = deps();
    d.readHistory.mockRejectedValue(new Error('cannot read /private/path/here'));
    const result = await call('GET', PATH, d);
    expect(result.status).toBe(500);
    expect(result.json).toMatchObject({ code: 'RUNS_HISTORY_UNAVAILABLE' });
    expect(JSON.stringify(result.json)).not.toContain('/private/path');
  });

  it('shares one in-flight sample across concurrent GETs', async () => {
    let release!: () => void;
    const gate = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const d = deps();
    d.sample.mockReturnValue(gate);
    const handler = createRunsHistoryApi(d);
    const fire = () => {
      const req = new PassThrough() as IncomingMessage & PassThrough;
      Object.assign(req, { method: 'GET', url: PATH, headers: {} });
      req.end();
      let status = 0;
      const res = { writeHead(code: number) { status = code; return this; }, end() { return this; } } as unknown as ServerResponse;
      return handler(ctx, req, res, PATH, 'GET').then((handled) => ({ handled, status }));
    };
    const [a, b] = [fire(), fire()];
    release();
    expect(await a).toEqual({ handled: true, status: 200 });
    expect(await b).toEqual({ handled: true, status: 200 });
    expect(d.sample).toHaveBeenCalledOnce();
  });
});
