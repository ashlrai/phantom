import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

const releases = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [
  { repo: 'ashlrai/phantom', path: '/fake', version: '3.29.15', latestTag: 'v3.29.15', releaseWorkflow: 'release.yml', gh: null, notes: [] },
] };
const pr = { number: 2345, title: 'release', version: '3.30.0', url: 'https://github.com/ashlrai/phantom/pull/2345', openedAt: '2026-10-31T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: 'MERGEABLE', blocked: false, pending: 0, failing: [], summary: 'ready', checks: [] };
const prData = (open: boolean) => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [{ repo: 'ashlrai/phantom', path: '/fake', notes: [], pr: open ? pr : null }] });
const status = (candidateVersion: string) => ({ v: 1, sourceState: 'healthy', installedVersion: '3.29.15', candidateVersion,
  headSha: null, headAt: null, originSha: null, branch: 'master', behind: 1, ahead: 0, dirty: false,
  lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true });

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(candidate: string) {
  let merged = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.includes('/self-update')) return Response.json({ outcome: 'already-current', restart: {} });
    if (init?.method === 'POST') { merged = true; return Response.json({ ok: true, sha: 'abcdef123456' }); }
    if (url.includes('/release-pr')) return Response.json(prData(!merged));
    if (url.includes('/self-update')) return Response.json(status(candidate));
    return Response.json(releases);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ToastProvider><FleetReleasesPane {...{ visible: true } as PaneProps} /></ToastProvider>);
  return fetcher;
}

it('shows a ready candidate and the existing update control after a merge', async () => {
  const fetcher = setup('3.30.0');
  vi.stubGlobal('confirm', () => true);
  fireEvent.click(await screen.findByRole('button', { name: 'Merge release PR' }));
  expect(await screen.findByText('3.30.0 is ready (running 3.29.15).')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
  expect(screen.getByText('No release PR open')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
  expect((await screen.findAllByText('Already on the newest commit.')).length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/verse/ops/self-update' && init?.method === 'POST' && JSON.parse(String(init.body)).action === 'apply')).toBe(true);
});

it('shows the merged line immediately and never calls an equal version ready', async () => {
  setup('3.29.15');
  fireEvent.click(await screen.findByRole('button', { name: 'Merge release PR' }));
  expect(await screen.findByText('Release PR #2345 merged 0 min ago. The tag workflow runs next; the update appears here when the release is published.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
});

it('stops status polling at 45 minutes', async () => {
  vi.useFakeTimers();
  const fetcher = setup('3.29.15');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  fireEvent.click(screen.getByRole('button', { name: 'Merge release PR' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const reads = () => fetcher.mock.calls.filter(([url]) => url.includes('/self-update')).length;
  expect(reads()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(44 * 60_000); });
  expect(reads()).toBe(45);
  await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
  expect(reads()).toBe(45);
});
