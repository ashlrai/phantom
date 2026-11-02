/**
 * Tests for `GET /api/verse/github/fleet-backlog` in
 * src/core/verse/github-api.ts — the route that lets the hub tell the desktop
 * console which open fleet PRs are stuck and why.
 *
 * FULLY HERMETIC. `gh` is injected through deps.fleetBacklog (no subprocess),
 * the enrolled-repo allowlist is injected through deps.enrolledRepos (no
 * enrollment registry, no git probes), and the 60 s response cache runs on an
 * injected ms clock. The response is captured through a minimal
 * ServerResponse stand-in, the same harness verse-github-api.test.ts uses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import type { MergeBacklogReadV1 } from '../src/core/fleet/merge-backlog-read.js';
import {
  VERSE_GITHUB_FLEET_BACKLOG_ROUTE,
  handleVerseGithubApi,
  isVerseGithubPath,
  resetVerseGithubFleetBacklogCache,
  type VerseGithubApiDeps,
} from '../src/core/verse/github-api.js';

const SHA = 'a'.repeat(40);
const ENROLLED = 'ashlrai/phantom';
const ROUTE = VERSE_GITHUB_FLEET_BACKLOG_ROUTE;

interface Captured {
  status: number;
  json: unknown;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, json: null };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      captured.status = status;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(payload?: string) {
      (this as { writableEnded: boolean }).writableEnded = true;
      if (typeof payload === 'string') {
        try {
          captured.json = JSON.parse(payload) as unknown;
        } catch {
          captured.json = payload;
        }
      }
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

/** One `gh pr list --json` row. */
function ghRow(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number, state: 'OPEN', isDraft: false,
    headRefOid: SHA, headRefName: `fleet/job-${number}`, baseRefName: 'master',
    isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    title: `PR ${number}`, updatedAt: '2026-11-01T19:00:00.000Z',
    ...over,
  };
}

function deps(over: VerseGithubApiDeps = {}): VerseGithubApiDeps {
  return {
    knownRoots: () => [],
    read: () => ({ repos: [], observedAt: '2026-11-01T00:00:00.000Z' }),
    describePlans: () => [],
    loadProposal: () => null,
    enrolledRepos: () => [ENROLLED],
    ...over,
  };
}

async function call(url: string, method = 'GET', over: VerseGithubApiDeps = {}): Promise<Captured & { handled: boolean }> {
  const path = url.split('?')[0] ?? url;
  const { res, captured } = fakeRes();
  const req = { url, method } as IncomingMessage;
  const handled = await handleVerseGithubApi({}, req, res, path, method, deps(over));
  return { ...captured, handled };
}

const body = (out: Captured) => out.json as MergeBacklogReadV1;

beforeEach(() => resetVerseGithubFleetBacklogCache());

describe('route matching', () => {
  it('claims the fleet-backlog route and still leaves foreign paths alone', async () => {
    expect(isVerseGithubPath(ROUTE)).toBe(true);
    expect(isVerseGithubPath(`${ROUTE}/x`)).toBe(false);
    expect(isVerseGithubPath('/api/verse/github')).toBe(true);
    const out = await call('/api/verse/bootstrap');
    expect(out.handled).toBe(false);
  });

  it('is GET-only like the other verse github reads', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const out = await call(`${ROUTE}?repo=${ENROLLED}`, method);
      expect(out.status).toBe(404);
    }
  });
});

describe('repo validation', () => {
  it('400s when repo is missing or malformed', async () => {
    for (const url of [ROUTE, `${ROUTE}?repo=`, `${ROUTE}?repo=${encodeURIComponent('../x')}`,
      `${ROUTE}?repo=${encodeURIComponent('no-slash')}`, `${ROUTE}?repo=${encodeURIComponent('/etc/passwd')}`]) {
      const out = await call(url);
      expect(out.status, url).toBe(400);
      expect(out.json).toMatchObject({ code: 'VERSE_INVALID' });
    }
  });

  it('404s for a well-formed repo that is not enrolled, without calling gh', async () => {
    let ghCalled = false;
    const gh: CloudGh = async () => { ghCalled = true; return { ok: true, stdout: '[]', stderr: '' }; };
    const out = await call(`${ROUTE}?repo=acme/unknown`, 'GET', { fleetBacklog: { gh } });
    expect(out.status).toBe(404);
    expect(ghCalled).toBe(false);
  });
});

describe('backlog body', () => {
  it('lists every open PR with merge state, job and planner advice', async () => {
    const gh = async () => ({
      ok: true,
      stdout: JSON.stringify([
        ghRow(31, { title: 'bridge: RQ-PHX-ABC31', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
        ghRow(32, { mergeStateStatus: 'BLOCKED', statusCheckRollup: [] }),
        ghRow(33),
      ]),
      stderr: '',
    });
    const out = await call(`${ROUTE}?repo=${ENROLLED}`, 'GET', {
      fleetBacklog: { gh, states: () => new Map(), now: () => new Date('2026-11-01T20:00:00.000Z') },
    });
    expect(out.status).toBe(200);
    const result = body(out);
    expect(result.v).toBe(1);
    expect(result.repo).toBe(ENROLLED);
    expect(result.source).toBe('ok');
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      number: 31,
      mergeStateStatus: 'DIRTY',
      job: 'RQ-PHX-ABC31',
      classification: { class: 'conflicted' },
      suggestedAction: 'recut',
    });
    expect(result.items[2]).toMatchObject({ number: 33, suggestedAction: 'merge' });
    expect(result.counts.mergeState).toEqual({ DIRTY: 1, BLOCKED: 1, CLEAN: 1 });
  });

  it('matches the enrolled repo case-insensitively and answers the canonical name', async () => {
    const gh = async () => ({ ok: true, stdout: '[]', stderr: '' });
    const out = await call(`${ROUTE}?repo=ASHLRAI%2Fphantom`, 'GET', { fleetBacklog: { gh } });
    expect(out.status).toBe(200);
    expect(body(out).repo).toBe(ENROLLED);
  });
});

describe('cache', () => {
  it('calls gh once per repo within 60 s and again after the window', async () => {
    let calls = 0;
    let now = 1_000_000;
    const gh: CloudGh = async () => { calls += 1; return { ok: true, stdout: '[]', stderr: '' }; };
    const over: VerseGithubApiDeps = {
      fleetBacklog: { gh },
      fleetBacklogCacheNow: () => now,
    };
    const url = `${ROUTE}?repo=${ENROLLED}`;
    expect((await call(url, 'GET', over)).status).toBe(200);
    expect((await call(url, 'GET', over)).status).toBe(200);
    expect(calls).toBe(1);
    now += 61_000;
    expect((await call(url, 'GET', over)).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('caches repos independently', async () => {
    let calls = 0;
    const gh: CloudGh = async () => { calls += 1; return { ok: true, stdout: '[]', stderr: '' }; };
    const over: VerseGithubApiDeps = {
      enrolledRepos: () => [ENROLLED, 'acme/app'],
      fleetBacklog: { gh },
      fleetBacklogCacheNow: () => 0,
    };
    await call(`${ROUTE}?repo=${ENROLLED}`, 'GET', over);
    await call(`${ROUTE}?repo=acme/app`, 'GET', over);
    expect(calls).toBe(2);
  });
});

describe('gh failure', () => {
  it('answers 503 with the v1 gh-failed body and never throws', async () => {
    const gh: CloudGh = async () => ({ ok: false, stdout: '', stderr: 'gh exploded' });
    const out = await call(`${ROUTE}?repo=${ENROLLED}`, 'GET', { fleetBacklog: { gh } });
    expect(out.status).toBe(503);
    const result = body(out);
    expect(result.v).toBe(1);
    expect(result.source).toBe('gh-failed');
    expect(result.items).toEqual([]);
    // gh stderr never reaches the response.
    expect(JSON.stringify(result)).not.toContain('gh exploded');
  });
});

describe('read-only posture', () => {
  it('only ever invokes `gh pr list` — no close, update or merge can slip in', async () => {
    const calls: string[][] = [];
    const gh: CloudGh = async (args) => { calls.push([...args]); return { ok: true, stdout: '[]', stderr: '' }; };
    const url = `${ROUTE}?repo=${ENROLLED}`;
    let now = 0;
    const over: VerseGithubApiDeps = { fleetBacklog: { gh }, fleetBacklogCacheNow: () => now };
    await call(url, 'GET', over);
    now += 61_000;
    await call(url, 'GET', over);
    expect(calls.length).toBe(2);
    for (const argv of calls) {
      expect(argv[0]).toBe('pr');
      expect(argv[1]).toBe('list');
      expect(argv).toEqual(['pr', 'list', '--repo', ENROLLED, '--state', 'open', '--limit', '100',
        '--json', expect.stringContaining('mergeStateStatus')]);
    }
  });
});
