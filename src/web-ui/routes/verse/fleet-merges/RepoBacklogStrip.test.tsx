import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { RepoBacklogStrip } from './RepoBacklogStrip.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const root = (name: string) => ({ path: `/x/${name}`, name, remote: { state: 'github', nameWithOwner: name, defaultBranch: 'main' } });
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); evictAll(); });

it('renders the headline and a row per repo', async () => {
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === '/api/verse/github') return { observedAt: '', repos: [root('example-org/alpha'), root('example-org/beta'), root('example-org/gamma')] };
    if (path.endsWith('alpha')) return { source: 'ok', items: [{ mergeStateStatus: 'DIRTY', updatedAt: at }, { mergeStateStatus: 'BEHIND', updatedAt: null }], counts: { mergeState: { DIRTY: 1, BEHIND: 1 } } };
    if (path.endsWith('beta')) return { source: 'ok', items: [{ mergeStateStatus: 'CLEAN', updatedAt: null }], counts: { mergeState: { CLEAN: 1 } } };
    throw new ApiError('gh failed', 503, path);
  });
  render(<RepoBacklogStrip visible />);
  expect(await screen.findByText(/2 repos · 3 open PRs · 1 DIRTY · 1 repo unavailable/)).toBeInTheDocument();
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows.map(row => row.textContent)).toEqual([
    'example-org/alpha2113 h', 'example-org/beta100—', 'example-org/gammaunavailable',
  ]);
  expect(within(rows[0]!).queryByRole('button')).toBeNull();
});

it('says so when the index cannot be read', async () => {
  vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
  render(<RepoBacklogStrip visible />);
  expect(await screen.findByText('Repo backlog unavailable')).toBeInTheDocument();
});
