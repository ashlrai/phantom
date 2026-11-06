import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createFleetCiRunsApi, VERSE_FLEET_CI_RUNS_PATH as PATH } from '../src/core/verse/fleet-ci-runs-api.js';
import { summarizeCiRuns, type readCiRunFacts } from '../src/core/fleet/ci-run-facts.js';
import { mountedApiModules, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
async function call(api: ApiModule, query = '', method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH + query, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, PATH, method);
  return { status, handled, body: text ? JSON.parse(text) : null };
}
it('returns contract JSON, shares in-flight cache, expires and declines POST', async () => {
  let now = 1000;
  const read = vi.fn(async (opts: Parameters<typeof readCiRunFacts>[0]) => summarizeCiRuns([], new Map(), { nowMs: opts.nowMs ?? 0, windowHours: opts.windowHours ?? 24, repo: opts.repo }));
  const api = createFleetCiRunsApi({ read, repo: async () => 'ashlrai/phantom', now: () => now });
  const [a, b] = await Promise.all([call(api), call(api)]);
  expect(a.status).toBe(200); expect(b.body).toEqual(a.body);
  expect(Object.keys(a.body).sort()).toEqual(['v', 'generatedAt', 'repo', 'windowHours', 'available', 'reason', 'total', 'byEvent', 'byWorkflow', 'failures', 'daily', 'recent'].sort());
  expect(read).toHaveBeenCalledTimes(1);
  now += 300001; await call(api); expect(read).toHaveBeenCalledTimes(2);
  expect(await call(api, '', 'POST')).toMatchObject({ status: 404, handled: false });
});
it.each([['?hours=0', 1], ['?hours=999', 168], ['?hours=NaN', 24], ['', 24]])('clamps hours %s', async (query, hours) => {
  const api = createFleetCiRunsApi({ repo: async () => null });
  expect((await call(api, query)).body).toMatchObject({ windowHours: hours, available: false });
});
it('mounts the route', () => { expect(mountedApiModules().some(m => m.id === 'fleet-ci-runs')).toBe(true); });
