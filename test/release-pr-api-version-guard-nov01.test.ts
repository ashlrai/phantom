import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import {
  createReleasePrApi, VERSE_RELEASE_PR_MERGE_PATH as MERGE, VERSE_RELEASE_PR_PATH as PATH, type ReleasePrResponseV1,
} from '../src/core/verse/ops-release-pr-api.js';
import type { OpsRunner } from '../src/core/verse/ops-releases.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const REPO = 'ashlrai/phantom';
const CHECKOUT = '/checkout/phantom';
// Nov 1: the open release PR still wants 3.29.16 while the tree targets 3.30.0.
const PR_32916 = JSON.stringify([{
  number: 1479, title: 'chore(master): release 3.29.16', url: 'https://github.com/ashlrai/phantom/pull/1479',
  createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T13:00:00Z',
  mergeable: 'MERGEABLE', headRefName: 'release-please--master',
  statusCheckRollup: [{ name: 'Merge Gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
}]);
const VIEW = JSON.stringify({ mergeCommit: { oid: 'a1b2c3d4e5f6' } });

const ghAndGit: OpsRunner = async (bin, args) => {
  if (bin === 'git') return `git@github.com:${REPO}.git`;
  if (args[1] === 'list') return PR_32916;
  if (args[1] === 'merge') return 'Merged';
  if (args[1] === 'view') return VIEW;
  return null;
};

const handler = (treeVersion: string | null, run: OpsRunner = ghAndGit) => createReleasePrApi({
  enrolled: () => [CHECKOUT], run, readTreeVersion: async () => treeVersion,
});

async function get(api: ApiModule) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method: 'GET', url: PATH }); req.end();
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { payload = chunk ?? ''; return this; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: payload ? JSON.parse(payload) as ReleasePrResponseV1 : null };
}

async function post(api: ApiModule, body: unknown) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, {
    method: 'POST', url: MERGE,
    headers: { 'content-type': 'application/json', 'x-ashlr-token': 'fixture-token' },
  });
  req.end(JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: true } as VerseApiContext;
  const handled = await api(ctx, req, res, MERGE, 'POST');
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

const mergeCalls = (run: ReturnType<typeof vi.fn>) =>
  run.mock.calls.filter(([, args]) => (args as string[])[1] === 'merge');

it('GET reports the tree version and the downgrade verdict with the note', async () => {
  const result = await get(handler('3.30.0'));
  expect(result.handled).toBe(true);
  expect(result.status).toBe(200);
  const entry = result.body?.repos[0];
  expect(entry?.repo).toBe(REPO);
  expect(entry?.pr?.version).toBe('3.29.16');
  expect(entry?.treeVersion).toBe('3.30.0');
  expect(entry?.versionVerdict).toBe('downgrade');
  expect(entry?.notes.some((line) => line.includes('would ship 3.29.16 but the tree targets 3.30.0'))).toBe(true);
});

it('POST merge without confirmVersion answers 409 version-downgrade and never runs gh pr merge', async () => {
  const run = vi.fn(ghAndGit);
  const result = await post(handler('3.30.0', run), { repo: REPO, number: 1479 });
  expect(result).toMatchObject({ handled: true, status: 409 });
  expect(result.body).toMatchObject({ code: 'version-downgrade', prVersion: '3.29.16', treeVersion: '3.30.0' });
  expect(String(result.body?.error)).toContain('would ship 3.29.16 but the tree targets 3.30.0');
  expect(mergeCalls(run)).toHaveLength(0);
});

it('POST merge with confirmVersion equal to the PR version merges and echoes confirmedVersion', async () => {
  const run = vi.fn(ghAndGit);
  const result = await post(handler('3.30.0', run), { repo: REPO, number: 1479, confirmVersion: '3.29.16' });
  expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true, sha: 'a1b2c3d4e5f6', confirmedVersion: '3.29.16' } });
  expect(run).toHaveBeenCalledWith('gh', ['pr', 'merge', '1479', '--repo', REPO, '--merge', '--delete-branch=false']);
});

it('POST merge proceeds without confirmVersion when the tree matches the PR version', async () => {
  const run = vi.fn(ghAndGit);
  const result = await post(handler('3.29.16', run), { repo: REPO, number: 1479 });
  expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true } });
  expect(mergeCalls(run)).toHaveLength(1);
});

it('an unknown body key still answers 400', async () => {
  const api = handler('3.30.0');
  for (const bad of [{ repo: REPO, number: 1479, extra: 1 }, { repo: REPO, number: 1479, confirmVersion: '3.29.16', bogus: true },
    { repo: REPO, number: 1479, confirmVersion: 32916 }]) {
    expect((await post(api, bad)).status, JSON.stringify(bad)).toBe(400);
  }
});

it('a repo the enrolled list cannot prove answers 404 not-found', async () => {
  const run = vi.fn(ghAndGit);
  const result = await post(handler('3.30.0', run), { repo: 'other/repo', number: 1479 });
  expect(result).toMatchObject({ handled: true, status: 404, body: { code: 'not-found' } });
  expect(mergeCalls(run)).toHaveLength(0);
});
