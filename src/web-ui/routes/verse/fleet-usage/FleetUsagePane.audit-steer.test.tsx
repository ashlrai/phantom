import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));
vi.mock('./usage-audit-queries.js', () => ({
  usageAuditQuery: {
    key: 'test-usage-audit-steer',
    fetch: async () => ({
      incidents: 1,
      sources: { usageJournal: { state: 'healthy' } },
      lanes: (['idle', 'moving', 'incident', 'reset-observed', 'insufficient-evidence'] as const).map(classification => ({
        lane: `${classification}-lane`, classification, pctUsedFirst: 62, pctUsedLast: 62,
        pctUsedDelta: 0, observedMinutes: 47, reason: `${classification} reason`, nextAction: `${classification} action`,
      })),
    }),
  },
}));

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/verse/accounts')
      ? Response.json({ accounts: [] })
      : Response.json({ lanes: [] })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens an interjection with idle-lane evidence and only offers steering for idle or incident lanes', async () => {
  render(<FleetUsagePane {...({ visible: true } as PaneProps)} />);
  const idle = (await screen.findByText('idle-lane')).closest('li') as HTMLElement;
  const section = screen.getByRole('region', { name: 'Zero waste (last hour)' });
  const moving = within(section).getByText('moving-lane').closest('li') as HTMLElement;
  const incident = within(section).getByText('incident-lane').closest('li') as HTMLElement;
  expect(within(moving).queryByRole('button', { name: /steer/i })).not.toBeInTheDocument();
  for (const name of ['reset-observed-lane', 'insufficient-evidence-lane']) {
    const row = within(section).getByText(name).closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /steer/i })).not.toBeInTheDocument();
  }
  expect(within(incident).getByRole('button', { name: 'Steer incident-lane' })).toBeInTheDocument();
  fireEvent.click(within(idle).getByRole('button', { name: 'Steer idle-lane' }));
  expect(openInterjectDialog).toHaveBeenCalledOnce();
  expect(openInterjectDialog).toHaveBeenCalledWith({
    prefill: expect.stringContaining('idle-lane'),
  });
  const prefill = vi.mocked(openInterjectDialog).mock.calls[0]?.[0]?.prefill;
  expect(prefill).toContain('idle reason');
  expect(prefill).toContain('idle action');
});
