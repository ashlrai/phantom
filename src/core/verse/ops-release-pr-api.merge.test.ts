import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiModule } from './api-modules.js';
import { createReleasePrApi, VERSE_RELEASE_PR_MERGE_PATH as MERGE } from './ops-release-pr-api.js';
import type { OpsRunner } from './ops-releases.js';
import { handleVerseApi, setMountedApiModulesForTest, type VerseApiContext } from './verse-api.js';

const GREEN = JSON.stringify([{
  number: 1479, title: 'chore(master): release 3.30.0', url: 'https://github.com/ashlrai/phantom/pull/1479',
  createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z',
  mergeable: 'MERGEABLE', headRefName: 'release-please--master',
  statusCheckRollup: [{ name: 'Merge Gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
}]);
const VIEW = JSON.stringify({ mergeCommit: { oid: 'a1b2c3d4e5f6' } });

const greenRun: OpsRunner = async (_bin, args) => {
  if (args[1] === 'list') return GREEN;
  if (args[1] === 'merge') return '';
  if (args[1] === 'view') return VIEW;
  return null;
};

interface CallOpts { token?: string; allowDispatch?: boolean; contentType?: string; rawBody?: string }
async function call(handler: ApiModule, body: unknown, opts: CallOpts = {}) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, {
    method: 'POST', url: MERGE,
    headers: { 'content-type': opts.contentType ?? 'application/json', 'x-ashlr-token': opts.token ?? 'fixture-token' },
  });
  req.end(opts.rawBody ?? JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: opts.allowDispatch ?? true } as VerseApiContext;
  const handled = await handler(ctx, req, res, new URL(MERGE, 'http://localhost').pathname, 'POST');
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

afterEach(() => setMountedApiModulesForTest(null));

it('rejects an invalid body, a bad token, a non-JSON body and a read-only server', async () => {
  const handler = createReleasePrApi({ run: greenRun });
  for (const bad of [undefined, 'x', [], {}, { number: 1479 }, { repo: 'a/b' },
    { repo: 'no slash at all', number: 1479 }, { repo: 'a/b/c', number: 1479 },
    { repo: 'a/b', number: 0 }, { repo: 'a/b', number: -1 }, { repo: 'a/b', number: '1479' },
    { repo: 'a/b', number: 1479, extra: 1 }]) {
    expect((await call(handler, bad)).status, JSON.stringify(bad)).toBe(400);
  }
  expect((await call(handler, undefined, { rawBody: '{oops' })).status).toBe(400);
  expect((await call(handler, { repo: 'a/b', number: 1479 }, { token: 'wrong' })).status).toBe(401);
  expect((await call(handler, { repo: 'a/b', number: 1479 }, { contentType: 'text/plain' })).status).toBe(415);
  expect((await call(handler, { repo: 'a/b', number: 1479 }, { allowDispatch: false })).status).toBe(404);
});

it('merges a green release PR and answers 200 with the sha', async () => {
  const run = vi.fn(greenRun);
  const handler = createReleasePrApi({ run });
  const result = await call(handler, { repo: 'ashlrai/phantom', number: 1479 });
  expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true, sha: 'a1b2c3d4e5f6' } });
  expect(run).toHaveBeenCalledWith('gh', ['pr', 'merge', '1479', '--repo', 'ashlrai/phantom', '--merge', '--delete-branch=false']);
});

it('maps not-green to 409, not-found to 404 and gh-failed to 502', async () => {
  const blocked: OpsRunner = async (_b, a) => a[1] === 'list'
    ? GREEN.replace('SUCCESS', 'FAILURE') : null;
  expect((await call(createReleasePrApi({ run: blocked }), { repo: 'a/b', number: 1479 })))
    .toMatchObject({ status: 409, body: { code: 'not-green' } });
  const none: OpsRunner = async () => '[]';
  expect((await call(createReleasePrApi({ run: none }), { repo: 'a/b', number: 1479 })))
    .toMatchObject({ status: 404, body: { code: 'not-found' } });
  const failing: OpsRunner = async (_b, a) => {
    if (a[1] === 'list') return GREEN;
    if (a[1] === 'merge') return null;
    return null;
  };
  expect((await call(createReleasePrApi({ run: failing }), { repo: 'a/b', number: 1479 })))
    .toMatchObject({ status: 502, body: { code: 'gh-failed' } });
});

it('answers 409 busy to a second POST while a merge is in flight', async () => {
  let mergeResolve: ((value: string | null) => void) | null = null;
  const slow: OpsRunner = async (_bin, args) => {
    if (args[1] === 'list') return GREEN;
    if (args[1] === 'merge') return await new Promise((resolve) => { mergeResolve = resolve; });
    if (args[1] === 'view') return VIEW;
    return null;
  };
  const handler = createReleasePrApi({ run: slow });
  const first = call(handler, { repo: 'a/b', number: 1479 });
  const second = call(handler, { repo: 'a/b', number: 1479 });
  const loser = await Promise.race([first, second]);
  expect(loser).toMatchObject({ status: 409, body: { code: 'busy' } });
  await vi.waitFor(() => expect(mergeResolve).toBeTypeOf('function'));
  mergeResolve!('');
  const results = await Promise.all([first, second]);
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
});

it('the real server routes the merge path past the workbench families to this module', async () => {
  const handler = createReleasePrApi({ run: greenRun });
  setMountedApiModulesForTest([{ id: 'release-pr', load: async () => handler }]);
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, {
    method: 'POST', url: MERGE,
    headers: { 'content-type': 'application/json', 'x-ashlr-token': 'fixture-token' },
  });
  req.end(JSON.stringify({ repo: 'ashlrai/phantom', number: 1479 }));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: true } as VerseApiContext;
  expect(await handleVerseApi(ctx, req, res, MERGE, 'POST')).toBe(true);
  expect(status).toBe(200);
  expect(JSON.parse(payload)).toMatchObject({ ok: true, sha: 'a1b2c3d4e5f6' });
});

it('declines other paths and methods on the merge route', async () => {
  const handler = createReleasePrApi({ run: greenRun });
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method: 'GET', url: MERGE, headers: {} });
  req.end();
  let status = 0;
  const res = { writeHead(code: number) { status = code; return this; }, end() { return this; } } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: true } as VerseApiContext;
  expect(await handler(ctx, req, res, MERGE, 'GET')).toBe(true);
  expect(status).toBe(405);
  expect(await handler(ctx, req, res, '/api/verse/release-pr/other', 'POST')).toBe(false);
});
