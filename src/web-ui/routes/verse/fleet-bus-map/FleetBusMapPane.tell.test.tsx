import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusMapPane } from './FleetBusMapPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));
beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(cleanup);

it('addresses Tell to the selected agent and omits it for Mason', async () => {
  vi.mocked(apiGet).mockImplementation(async (path) => path.includes('/agent-bus/') ? null : ({
    v: 1, hops: [{ id: '1', from: 'mason', to: 'graph-coordinator', inputTokens: null, outputTokens: null }],
    hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' },
  }));
  render(<FleetBusMapPane {...({ visible: true } as PaneProps)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Tell graph-coordinator' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: '@graph-coordinator: ' });
  expect(screen.queryByRole('button', { name: 'Tell mason' })).not.toBeInTheDocument();
});
