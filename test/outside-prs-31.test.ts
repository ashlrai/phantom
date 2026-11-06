/**
 * RQ-PHX-OUTSIDEPRSAPI31 — outside PRs on fleet repos and job collisions.
 *
 * Contract:
 *   - Per repo among running jobs (plus the workspace repo), open PRs whose
 *     head branch is not `codex-bridge/*` and whose author is not the fleet
 *     App are listed with their touched paths.
 *   - Each outside PR is collided against every running job's changed paths
 *     in that repo (`getFleetJobChanges`); a shared path is an overlap.
 *   - `gh` absent → `sourceState: 'missing'`, empty repos, never a throw;
 *     the route serves that body as a 200, not a 500.
 *   - No token, hostname, worktree path or remote URL is ever emitted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { listOutsidePrs, type ListOutsidePrsOptions, type OutsidePrsV1 } from '../src/core/fleet/outside-prs.js';
import type { FleetJobChangesV1 } from '../src/core/fleet/runs-job-changes.js';
import { handleFleetLiveApi, setFleetLiveDepsForTest, resetFleetLiveApiForTest } from '../src/core/verse/fleet-live-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/fleet/live/outside-prs';
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'outside-prs-'));
});
afterEach(async () => {
  resetFleetLiveApiForTest();
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

/** A fake checkout: `.git/config` naming origin so repo-identity resolves it. */
async function checkout(path: string, remote: string): Promise<string> {
  await mkdir(join(path, '.git'), { recursive: true });
  await writeFile(join(path, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
  return path;
}

/** runsDir with one claimed job whose .base names the given worktree. */
async function runsDirWith(job: string, worktree: string): Promise<string> {
  const runsDir = join(scratch, 'runs');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await writeFile(join(runsDir, 'queue', 'claimed.tsv'), `${job}\tclaude\twork\t12:00\t1730000000\n`);
  await writeFile(join(runsDir, `${job}.base`), `abc1234 codex-bridge/${job} ${worktree}\n`);
  return runsDir;
}

function changedFiles(...paths: string[]): FleetJobChangesV1 {
  return {
    schema: 'fleet.job.changes.v1', generatedAt: '2026-10-31T12:00:00Z', job: 'RQ-FAKE-1', state: 'live',
    baseSha: 'abc1234', files: paths.map((path) => ({ path, added: 1, removed: 0, status: 'modified' as const })),
    totals: { files: paths.length, added: paths.length, removed: 0 }, truncated: false,
  };
}

/** gh answers two PRs on acme/widgets: a fleet-branch one and an outside one touching src/a.ts. */
const fakeGh: NonNullable<ListOutsidePrsOptions['gh']> = async (_cwd, args) => {
  const key = args.join(' ');
  if (key === '--version') return 'gh version 2.99.0';
  if (key.startsWith('pr list')) {
    return JSON.stringify([
      { number: 41, title: 'bridge: fleet job', author: { login: 'mason' }, headRefName: 'codex-bridge/RQ-FAKE-1', updatedAt: '2026-10-31T10:00:00Z' },
      { number: 42, title: 'outside change', author: { login: 'mason' }, headRefName: 'feature/touch-a', updatedAt: '2026-10-31T11:00:00Z' },
      { number: 43, title: 'bot change', author: { login: 'ashlr-fleet[bot]' }, headRefName: 'fix/bot-thing', updatedAt: '2026-10-31T11:30:00Z' },
    ]);
  }
  if (key.startsWith('pr view 42')) return JSON.stringify({ files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] });
  return null;
};

async function fixtureOpts(): Promise<ListOutsidePrsOptions> {
  const worktree = await checkout(join(scratch, 'wt', 'RQ-FAKE-1'), 'https://github.com/acme/widgets.git');
  const workspaceDir = await checkout(join(scratch, 'workspace'), 'https://github.com/acme/widgets.git');
  return {
    runsDir: await runsDirWith('RQ-FAKE-1', worktree),
    homeDir: scratch,
    workspaceDir,
    gh: fakeGh,
    jobChanges: async () => changedFiles('src/a.ts', 'src/c.ts'),
  };
}

describe('listOutsidePrs', () => {
  it('excludes fleet-branch and fleet-bot PRs and reports the overlap on src/a.ts', async () => {
    const result = await listOutsidePrs(await fixtureOpts());
    expect(result.v).toBe(1);
    expect(result.sourceState).toBe('healthy');
    expect(result.repos).toHaveLength(1);
    const repo = result.repos[0]!;
    expect(repo.repo).toBe('acme/widgets');
    expect(repo.state).toBe('healthy');
    expect(repo.prs.map((pr) => pr.number)).toEqual([42]);
    const pr = repo.prs[0]!;
    expect(pr).toMatchObject({ title: 'outside change', author: 'mason', head: 'feature/touch-a', updatedAt: '2026-10-31T11:00:00.000Z' });
    expect(pr.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(pr.overlaps).toEqual([{ job: 'RQ-FAKE-1', paths: ['src/a.ts'] }]);
    // No path, hostname or token may appear anywhere in the payload.
    expect(JSON.stringify(result)).not.toMatch(/scratch|\/Users\/|github\.com|ghp_|token/i);
  });

  it('returns missing when gh cannot run at all', async () => {
    const result = await listOutsidePrs({ ...(await fixtureOpts()), gh: async () => null });
    expect(result).toMatchObject({ sourceState: 'missing', repos: [] });
  });
});

describe('GET /api/verse/fleet/live/outside-prs', () => {
  async function call(method: string, url = PATH) {
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, { method, url, headers: {} });
    req.end();
    let status = 0, payload = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { payload = chunk ?? ''; return this; },
    } as unknown as ServerResponse;
    const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
    const handled = await handleFleetLiveApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
    return { handled, status, body: payload ? (JSON.parse(payload) as OutsidePrsV1) : null };
  }

  it('serves a 200 missing body (not a 500) when gh is absent', async () => {
    setFleetLiveDepsForTest({ outsidePrs: () => listOutsidePrs({ gh: async () => null }) });
    const result = await call('GET');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ v: 1, sourceState: 'missing', repos: [] });
  });

  it('serves the outside-PR payload and rejects queries and other methods', async () => {
    const opts = await fixtureOpts();
    setFleetLiveDepsForTest({ outsidePrs: () => listOutsidePrs(opts) });
    const result = await call('GET');
    expect(result.status).toBe(200);
    expect(result.body?.sourceState).toBe('healthy');
    expect(result.body?.repos[0]?.prs[0]?.overlaps).toEqual([{ job: 'RQ-FAKE-1', paths: ['src/a.ts'] }]);
    expect((await call('GET', `${PATH}?repo=x`)).status).toBe(400);
    expect((await call('POST')).status).toBe(405);
    expect((await call('GET', '/api/verse/fleet/live/elsewhere')).handled).toBe(false);
  });
});
