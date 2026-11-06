import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the blocker and prefills a message to the leaders', async () => {
  const releases = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [
    { repo: 'ashlrai/phantom', path: '/fixture', version: '3.29.0', latestTag: 'v3.29.0', releaseWorkflow: null, gh: null, notes: [] },
  ] };
  const releasePr = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [
    { repo: 'AshlrAI/Phantom', path: '/fixture', notes: [], pr: {
      number: 1479, title: 'Release 3.30.0', version: '3.30.0', url: 'https://example.test/pull/1479',
      openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: 'UNKNOWN',
      blocked: true, pending: 0, failing: ['Dependency Audit'], summary: 'blocked',
      checks: [{ name: 'Dependency Audit', state: 'fail', url: null }],
    } },
  ] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/release-pr') ? releasePr : releases)));
  render(<FleetReleasesPane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('Blocked by: Dependency Audit')).toHaveAttribute('role', 'status');
  fireEvent.click(screen.getByRole('button', { name: 'Tell the leaders' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re release PR #1479 (ashlrai/phantom): Blocked by: Dependency Audit. ' });
});
