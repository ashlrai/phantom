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
  const response = { enrollmentStatus: 'ready', repos: [phantom] };
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
