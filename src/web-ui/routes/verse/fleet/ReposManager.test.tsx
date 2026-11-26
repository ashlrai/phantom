import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ReposManager } from './ReposManager.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
});

it('shows fleet evidence and sends only priority to the mutation endpoint', async () => {
  const phantom = {
    label: 'Phantom', repo: 'ashlrai/phantom', logo: 'phantom-workbench-logo.svg', enrolled: true, grantStage: 'merge',
    priority: 'normal', queueDepth: 4, mergesPerDay: 3, openPrs: 7, ciHealth: 'red',
    lastRelease: { tag: 'v4.0', publishedAt: '2026-11-22T00:00:00Z' },
    allocation: { share: 0.42, source: 'queue', reasonCodes: ['default_branch_ci_fix_ready'] },
  };
  const response = { enrollmentStatus: 'ready', prioritySync: 'local-only', canManageGrant: true, repos: [phantom] };
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/repos/priority') {
      phantom.priority = JSON.parse(String(init?.body)).priority;
      return Response.json({ priority: phantom.priority });
    }
    return Response.json(response);
  });
  vi.stubGlobal('fetch', fetchMock);
  setMutationToken('b'.repeat(64));
  const open = vi.fn();
  const user = userEvent.setup();
  render(<ReposManager grantFlow={{ open, sheet: null }} readOnly={false} />);
  const row = await screen.findByRole('row', { name: /Phantom/ });
  expect(screen.getByText('Not synced')).toBeVisible();
  expect(within(row).getByText('v4.0')).toBeInTheDocument();
  expect(within(row).getByText('42.0%')).toBeInTheDocument();
  await user.click(within(row).getByText('Why'));
  expect(within(row).getByText('default_branch_ci_fix_ready')).toBeVisible();
  await user.click(within(row).getByRole('button', { name: 'Propose only' }));
  expect(open).toHaveBeenCalledWith('grant', expect.any(String), null, {
    repoChange: { repo: 'ashlrai/phantom', intent: 'propose' },
  });
  await user.selectOptions(within(row).getByRole('combobox'), 'pause');
  await waitFor(() => expect(within(row).getByRole('combobox')).toHaveValue('pause'));
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/repos/priority')).toHaveLength(1);
});

it('shows a signed-only repository with a fallback mark and disables grant controls on workers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    enrollmentStatus: 'ready', prioritySync: 'local-only', canManageGrant: false,
    repos: [{ repo: 'ashlrai/new-project', label: 'new-project', logo: null, enrolled: false, grantStage: 'propose',
      priority: 'normal', queueDepth: null, mergesPerDay: null, openPrs: null, ciHealth: null, lastRelease: null,
      allocation: { share: 0.2, source: 'estimate', reasonCodes: ['docs_freshness_drift'] } }],
  })));
  render(<ReposManager grantFlow={{ open: vi.fn(), sheet: null }} readOnly={false} />);
  const row = await screen.findByRole('row', { name: /new-project/ });
  expect(within(row).getByText('NE')).toBeVisible();
  expect(within(row).getByText('propose')).toBeVisible();
  expect(within(row).getByRole('button', { name: 'Remove' })).toBeDisabled();
  expect(within(row).getByRole('button', { name: 'Review merge' })).toBeDisabled();
  expect(within(row).getByRole('combobox')).toBeEnabled();
  await userEvent.setup().click(within(row).getByText('Why'));
  expect(within(row).getByText('docs_freshness_drift')).toBeVisible();
});
