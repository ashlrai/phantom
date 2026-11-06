import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRepoRelease } from '../../../../core/verse/ops-releases.js';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OpsRepoReleaseV1 } from '../../../../core/verse/ops-types.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';
import { isOpsReleases, orderRepos } from './fleet-releases-model.js';

const repo: OpsRepoReleaseV1 = {
  repo: 'ashlrai/phantom', path: '/fixture', version: null, latestTag: 'v3.29.15',
  releaseWorkflow: null, gh: null, notes: [],
};
const payload = (repos: OpsRepoReleaseV1[]) => ({
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sourceState: 'healthy', repos,
});
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([620, 0])('shows %s commits since the tag', async count => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload([{ ...repo, commitsSinceTag: count }]))));
  render(createElement(FleetReleasesPane, { visible: true } as PaneProps));
  expect(await screen.findByText(`${count} commits since v3.29.15`)).toBeInTheDocument();
});

it.each([null, undefined])('shows an unknown count for %s, including older payloads', async count => {
  const row = count === undefined ? repo : { ...repo, commitsSinceTag: count };
  expect(isOpsReleases(payload([row]))).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload([row]))));
  render(createElement(FleetReleasesPane, { visible: true } as PaneProps));
  expect(await screen.findByText('Commits since tag: unknown')).toBeInTheDocument();
});

it('orders largest gaps first and unknowns last without mutating input', () => {
  const rows = [repo, { ...repo, repo: 'zero', commitsSinceTag: 0 },
    { ...repo, repo: 'large', commitsSinceTag: 620 },
    { ...repo, repo: 'small', commitsSinceTag: 2 },
    { ...repo, repo: 'unknown', commitsSinceTag: null }];
  expect(orderRepos(rows).map(row => row.repo)).toEqual(['large', 'small', 'zero', 'ashlrai/phantom', 'unknown']);
  expect(rows[0]).toBe(repo);
});

it.each([-1, 1.5, '620', Infinity, NaN])('rejects invalid count %s', count => {
  expect(isOpsReleases(payload([{ ...repo, commitsSinceTag: count } as OpsRepoReleaseV1]))).toBe(false);
});


// Real git subprocesses use the backend real-I/O lane's 60s budget.
it('shows the real count probed from a fixture checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-pane-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '--quiet');
    const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
    commit();
    git('tag', 'v1.0.0');
    commit();
    commit();
    const row = await probeRepoRelease(dir, { identity: () => null });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload([row]))));
    render(createElement(FleetReleasesPane, { visible: true } as PaneProps));
    expect(await screen.findByText('2 commits since v1.0.0')).toBeInTheDocument();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
