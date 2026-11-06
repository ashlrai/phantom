import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createReleasePrApi, VERSE_RELEASE_PR_PATH as PATH, type ReleasePrResponseV1 } from '../src/core/verse/ops-release-pr-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function call(handler: ApiModule, method = 'GET', url = PATH) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url }); req.end();
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { payload = chunk ?? ''; return this; } } as unknown as ServerResponse;
  const handled = await handler({} as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? JSON.parse(payload) as ReleasePrResponseV1 : null };
}
it('release PR route returns the projection and shares its fifteen-second cache', async () => {
  let now = 0;
  const run = vi.fn(async (bin: string) => bin === 'git' ? 'git@github.com:ashlrai/phantom.git' : JSON.stringify([{
    number: 1479, title: 'chore(master): release 3.30.0', headRefName: 'release-please--master',
    statusCheckRollup: [{ name: 'audit', status: 'COMPLETED', conclusion: 'FAILURE' }],
  }]));
  const handler = createReleasePrApi({ enrolled: () => ['/fixture'], run, now: () => now });
  const [a, b] = await Promise.all([call(handler), call(handler)]);
  expect(a).toMatchObject({ handled: true, status: 200, body: { v: 1, generatedAt: new Date(0).toISOString(), sourceState: 'healthy',
    repos: [{ repo: 'ashlrai/phantom', path: '/fixture', pr: { blocked: true, failing: ['audit'] }, notes: [] }] } });
  expect(b.body).toEqual(a.body); expect(run).toHaveBeenCalledTimes(2);
  now = 15_000; await call(handler); expect(run).toHaveBeenCalledTimes(4);
});
it('release PR route degrades unavailable or malformed gh answers but accepts empty lists', async () => {
  for (const raw of [null, 'garbage', '[]']) {
    const handler = createReleasePrApi({ enrolled: () => ['/fixture'], run: async (bin) => bin === 'git' ? 'https://github.com/a/b.git' : raw });
    const result = await call(handler);
    expect(result.status).toBe(200);
    expect(result.body?.sourceState).toBe(raw === '[]' ? 'healthy' : 'degraded');
    expect(result.body?.repos[0]?.pr).toBeNull();
    expect(result.body?.repos[0]?.notes.length).toBe(raw === '[]' ? 0 : 1);
  }
});
it('release PR route never probes unproven origins and rejects queries and POST', async () => {
  const run = vi.fn(async () => 'https://example.com/a/b.git');
  const handler = createReleasePrApi({ enrolled: () => ['/fixture'], run });
  expect((await call(handler)).body?.repos[0]).toMatchObject({ pr: null, notes: [expect.stringContaining('No GitHub origin')] });
  expect(run).toHaveBeenCalledTimes(1);
  expect((await call(handler, 'GET', `${PATH}?unknown=1`)).status).toBe(400);
  expect((await call(handler, 'POST')).handled).toBe(false);
  expect((await call(handler, 'GET', '/other')).handled).toBe(false);
});
