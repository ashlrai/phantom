import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { FleetSteeringPane } from './FleetSteeringPane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T04:20:00Z')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows pending orders and opens the interject dialog', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('leader-journal')
    ? Response.json({}, { status: 404 })
    : Response.json({ generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 480 }],
      sources: { runsDir: 'healthy', inbox: 'healthy' },
      inbox: [{ at: '2026-10-31 00:13', source: 'fake', text: 'first' },
        { at: '2026-10-31 00:19', source: 'fake', text: 'second' }], events: [] })));
  render(<FleetSteeringPane {...({ visible: true } as PaneProps)} />);
  const status = await screen.findByRole('status', { name: 'Pending orders' });
  expect(status).toHaveTextContent('2 orders waiting for the next leader pass · due in 7 min');
  expect(status).toHaveAttribute('data-tone', 'ok');
  fireEvent.click(screen.getByRole('button', { name: 'Send another' }));
  expect(openInterjectDialog).toHaveBeenCalledOnce();
  expect(openInterjectDialog).toHaveBeenCalledWith();
});
