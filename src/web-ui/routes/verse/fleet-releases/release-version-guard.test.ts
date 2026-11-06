import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { releasePrQuery } from '../fleet/release-pr-query.js';
import { closeInterjectDialog, takeInterjectPrefill } from '../fleet/interject-dialog-store.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReleaseVersion, releaseVersionGuard, treeVersionFor } from './release-version-guard.js';

const now = Date.parse('2026-11-01T06:00:00Z');
const pr = { number: 1479, version: '3.29.16', updatedAt: '2026-10-31T13:00:00Z' };
describe('release version guard', () => {
  it('blocks the stale downgrade and names the owner action', () => {
    expect(releaseVersionGuard(pr, '3.30.0', now)).toEqual({ verdict: 'downgrade', blockMerge: true,
      line: 'Merging #1479 would ship 3.29.16 and set the tree back from 3.30.0 · release PR last refreshed 17h ago · owner: give release-please the 3.30.0 version (a Release-As footer or the manifest), then merge' });
  });
  it.each([
    ['3.29.16', 'match'], ['3.28.0', 'ahead'], [null, 'unknown'], ['v3.30.0', 'unknown'],
  ] as const)('does not block tree %s (%s)', (tree, verdict) => {
    expect(releaseVersionGuard(pr, tree, now)).toEqual({ verdict, blockMerge: false, line: null });
  });
  it.each([null, undefined, 330, '3.30', 'v3.30.0', '3.30.0-rc.1', '3.30.0+build', ' 3.30.0', '10000.0.0', '3.30.0\n'])('rejects malformed version %s', value => {
    expect(parseReleaseVersion(value)).toBeNull();
  });
  it('parses bounded components and compares them numerically', () => {
    expect(parseReleaseVersion('9999.0001.0')).toEqual([9999, 1, 0]);
    expect(releaseVersionGuard({ ...pr, version: '3.9.0' }, '3.10.0', now).blockMerge).toBe(true);
  });
  it('prefers server tree data and falls back to the candidate', () => {
    expect(treeVersionFor({ treeVersion: '3.31.0' }, '3.30.0')).toBe('3.31.0');
    for (const entry of [undefined, null, {}, { treeVersion: null }, { treeVersion: 'bad' }, { treeVersion: 330 }]) {
      expect(treeVersionFor(entry, '3.30.0')).toBe('3.30.0');
      expect(treeVersionFor(entry, null)).toBeNull();
    }
  });
});

afterEach(() => { cleanup(); closeInterjectDialog(); clearMutationToken(); evictAll(); vi.unstubAllGlobals(); });
function renderGuardedPane(treeVersion?: unknown, refusal = false) {
  evictAll();
  setMutationToken('a'.repeat(64));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ code: 'version-downgrade', error: 'Version downgrade blocked by server' }, { status: 409 });
    if (url.includes('/release-pr')) return Response.json({ v: 1, generatedAt: pr.updatedAt, sourceState: 'healthy', repos: [{
      repo: 'ashlrai/phantom', path: '/fixture', notes: [], treeVersion, versionVerdict: treeVersion === 'malformed' ? { future: true } : undefined,
      pr: { ...pr, title: 'release 3.29.16', url: 'https://github.com/ashlrai/phantom/pull/1479', openedAt: pr.updatedAt,
        mergeable: 'MERGEABLE', blocked: false, pending: 0, failing: [], checks: [], summary: 'green' },
    }] });
    if (url.includes('/self-update')) return Response.json({
      v: 1, sourceState: 'healthy', candidateVersion: refusal ? null : '3.30.0', installedVersion: '3.30.0',
      headSha: null, headAt: null, originSha: null, branch: null, behind: null, ahead: null, dirty: null,
      lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: null,
    });
    return Response.json({ v: 1, generatedAt: pr.updatedAt, sourceState: 'healthy', repos: [{
      repo: 'ashlrai/phantom', path: '/fixture', version: '3.30.0', latestTag: null, releaseWorkflow: null,
      gh: null, notes: [],
    }] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(createElement(FleetReleasesPane, { visible: true } as PaneProps));
  return fetcher;
}
it.each(['3.30.0', undefined, 'malformed'])('blocks the pane merge using server/candidate %s', async tree => {
  const fetcher = renderGuardedPane(tree);
  expect(await screen.findByText(/Merging #1479 would ship 3.29.16/)).toHaveAttribute('data-tone', 'warn');
  const merge = screen.getByRole('button', { name: 'Merge release PR' });
  expect(merge).toBeDisabled();
  expect(merge).toHaveAttribute('title', 'blocked: version downgrade');
  expect(screen.getByRole('button', { name: 'Tell the leaders' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Tell the leaders' }));
  expect(takeInterjectPrefill()).toContain('Merging #1479 would ship 3.29.16');
  fireEvent.click(merge);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it('shows a server downgrade refusal inline with older client data', async () => {
  renderGuardedPane(undefined, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Merge release PR' }));
  expect(await screen.findByText('Version downgrade blocked by server')).toBeInTheDocument();
});

it('keeps the base response while ignoring malformed optional server fields', async () => {
  renderGuardedPane('malformed', true);
  const result = await releasePrQuery.fetch();
  expect(result.kind).toBe('available');
  if (result.kind !== 'available') throw new Error('Expected release data');
  expect(result.data.repos[0]?.treeVersion).toBeUndefined();
  expect(result.data.repos[0]?.versionVerdict).toBeUndefined();
  expect(result.data.repos[0]?.pr?.number).toBe(1479);
});
