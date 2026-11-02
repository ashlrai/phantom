/**
 * RQ-PHX-RELEASEPRMERGERECUT31 — the stranded merge feature of PR #2261,
 * re-cut onto current master. Three acceptance probes, no network:
 * the route refuses a non-green PR without ever running `gh pr merge`,
 * merges a green one with the exact argv, and the pane model derives the
 * reason the button stays disabled.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { createReleasePrApi, VERSE_RELEASE_PR_MERGE_PATH as MERGE } from '../src/core/verse/ops-release-pr-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { releasePrMergeBlocker, releasePrMergeable } from '../src/web-ui/routes/verse/fleet-releases/fleet-releases-model.js';
import type { ReleasePr } from '../src/web-ui/routes/verse/fleet/release-pr-query.js';

const REPO = 'ashlrai/phantom';

function listJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    number: 1479, title: 'chore(master): release 3.30.0', url: 'https://github.com/ashlrai/phantom/pull/1479',
    createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z',
    mergeable: 'MERGEABLE', headRefName: 'release-please--master',
    statusCheckRollup: [{ name: 'Merge Gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...over,
  }]);
}

async function post(handler: ApiModule, body: unknown) {
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
  const handled = await handler(ctx, req, res, new URL(MERGE, 'http://localhost').pathname, 'POST');
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

const mergeCalls = (run: ReturnType<typeof vi.fn>) => run.mock.calls.filter(([, args]) => (args as string[])[1] === 'merge');

describe('POST /api/verse/release-pr/merge', () => {
  it('refuses a non-green PR with a 4xx reason and never runs gh pr merge', async () => {
    const run = vi.fn(async (_bin: string, args: readonly string[]): Promise<string | null> =>
      args[1] === 'list' ? listJson({
        statusCheckRollup: [{ name: 'Dependency audit', status: 'COMPLETED', conclusion: 'FAILURE' }],
      }) : null);
    const handler = createReleasePrApi({ run });
    const result = await post(handler, { repo: REPO, number: 1479 });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'not-green' });
    expect(String(result.body?.error)).toContain('Dependency audit');
    expect(mergeCalls(run)).toHaveLength(0);
  });

  it('merges a green PR and passes the exact argv to gh', async () => {
    const run = vi.fn(async (_bin: string, args: readonly string[]): Promise<string | null> => {
      if (args[1] === 'list') return listJson();
      if (args[1] === 'merge') return 'Merged';
      if (args[1] === 'view') return JSON.stringify({ mergeCommit: { oid: 'a1b2c3d4e5f6' } });
      return null;
    });
    const handler = createReleasePrApi({ run });
    const result = await post(handler, { repo: REPO, number: 1479 });
    expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true, sha: 'a1b2c3d4e5f6' } });
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'merge', '1479', '--repo', REPO, '--merge', '--delete-branch=false']);
  });
});

describe('releases pane merge button model', () => {
  const green: ReleasePr = {
    number: 1479, title: 'chore(master): release 3.30.0', url: 'https://github.com/ashlrai/phantom/pull/1479',
    version: '3.30.0', openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z',
    mergeable: 'MERGEABLE', checks: [{ name: 'Merge Gate', state: 'pass', url: null }],
    failing: [], pending: 0, blocked: false, summary: '3.30.0 green, waiting for merge',
  };

  it('derives the disabled reason: the PR summary when not green, a conflicts line, null when green', () => {
    expect(releasePrMergeBlocker(green)).toBeNull();
    expect(releasePrMergeable(green)).toBe(true);
    const failing = { ...green, blocked: true, failing: ['Dependency audit'], summary: '3.30.0 blocked by Dependency audit' };
    expect(releasePrMergeBlocker(failing)).toBe('3.30.0 blocked by Dependency audit');
    expect(releasePrMergeable(failing)).toBe(false);
    const pending = { ...green, pending: 2, summary: '3.30.0 waiting on 2 checks' };
    expect(releasePrMergeBlocker(pending)).toBe('3.30.0 waiting on 2 checks');
    expect(releasePrMergeable(pending)).toBe(false);
    const conflicting = { ...green, mergeable: 'CONFLICTING' };
    expect(releasePrMergeBlocker(conflicting)).toContain('merge conflicts');
    expect(releasePrMergeable(conflicting)).toBe(false);
  });
});
