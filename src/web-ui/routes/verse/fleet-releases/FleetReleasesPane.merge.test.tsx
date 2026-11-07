import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

const props = { visible: true } as PaneProps;
const releases = () => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
  repos: [{ repo: 'ashlrai/phantom', path: '/phantom', version: '3.29.0', latestTag: 'v3.29.0', releaseWorkflow: 'release.yml',
    gh: { latestRelease: null, latestRun: null }, notes: [] }],
});
const prRow = (over: Record<string, unknown> = {}) => ({
  number: 1479, title: 'chore(master): release 3.30.0', version: '3.30.0',
  url: 'https://github.com/ashlrai/phantom/pull/1479', openedAt: '2026-10-28T12:00:00Z',
  updatedAt: '2026-10-31T12:00:00Z', mergeable: 'MERGEABLE', blocked: false, pending: 0,
  failing: [], summary: '3.30.0 green, waiting for merge',
  checks: [{ name: 'Merge Gate', state: 'pass', url: null }], ...over,
});
const prData = (pr: unknown) => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
  repos: [{ repo: 'AshlrAI/Phantom', path: '/phantom', notes: [], pr }] });

function setup(opts: { pr?: unknown; merge?: { status: number; body: unknown } } = {}) {
  const pr = 'pr' in opts ? opts.pr : prRow();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json(opts.merge?.body ?? { ok: true, sha: 'a1b2c3d4e5f6' }, { status: opts.merge?.status ?? 200 });
    return Response.json(url.includes('/release-pr') ? prData(pr) : releases());
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetReleasesPane {...props} />);
  return fetcher;
}
const posts = (fetcher: ReturnType<typeof setup>) =>
  fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('disables the merge button while the release PR is blocked', async () => {
  setup({ pr: prRow({ blocked: true, failing: ['Dependency audit'], summary: '3.30.0 blocked by Dependency audit',
    checks: [{ name: 'Dependency audit', state: 'fail', url: null }] }) });
  expect(await screen.findByRole('button', { name: 'Merge release PR' })).toBeDisabled();
});

it('disables the merge button without a mutation hold', async () => {
  clearMutationToken();
  setup();
  expect(await screen.findByRole('button', { name: 'Merge release PR' })).toBeDisabled();
});

it('merges a green release PR, shows the merged sha and refetches the row', async () => {
  const fetcher = setup();
  const button = await screen.findByRole('button', { name: 'Merge release PR' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(await screen.findByText('Merged a1b2c3d')).toBeInTheDocument();
  expect(posts(fetcher)).toHaveLength(1);
  const [url, init] = posts(fetcher)[0];
  expect(url).toBe('/api/verse/release-pr/merge');
  expect(JSON.parse(String(init?.body))).toEqual({ repo: 'ashlrai/phantom', number: 1479 });
  expect(new Headers(init?.headers).get('x-ashlr-token')).toBe('a'.repeat(64));
  await vi.waitFor(() => expect(fetcher.mock.calls.filter(([u]) => u === '/api/verse/release-pr').length).toBeGreaterThan(1));
});

it('shows the server refusal inline on a 409', async () => {
  setup({ merge: { status: 409, body: { code: 'not-green', error: '3.30.0 waiting on 2 checks' } } });
  fireEvent.click(await screen.findByRole('button', { name: 'Merge release PR' }));
  expect(await screen.findByText('3.30.0 waiting on 2 checks')).toBeInTheDocument();
});
