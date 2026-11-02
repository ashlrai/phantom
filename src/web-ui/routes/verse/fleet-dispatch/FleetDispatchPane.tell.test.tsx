import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const props = { visible: true, roots: ['/workspace'], host: { openTerminal: vi.fn() } } as unknown as PaneProps;

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T05:09:00Z')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('offers a prefilled leader handoff for stalled lanes and keeps the terminal action', async () => {
  const base = fleetRunsFixture().lanes[0]!;
  const snapshot = fleetRunsFixture({ claudeLane: 'down — token rejected', lanes: [
    { ...base, lane: 'codex-personal', running: 8, target: 24, queued: 1 },
    { ...base, lane: 'claude' },
    { ...base, lane: 'held-lane', held: true, heldReason: 'usage limit' },
    { ...base, lane: 'at-target', running: 4, target: 4 },
  ] });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));
  render(<FleetDispatchPane {...props} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Tell the leaders about codex-personal' }));
  expect(openInterjectDialog).toHaveBeenCalledExactlyOnceWith({ prefill: 'Re lane codex-personal (starved, 16 free slots): 16 free, 1 queued — last tick 9 min ago. ' });
  expect(screen.getByRole('button', { name: 'Tell the leaders about held-lane' })).toBeInTheDocument();
  const downRow = screen.getByRole('button', { name: 'Tell the leaders about claude' }).closest('li')!;
  expect(within(downRow).getByRole('button', { name: 'Paste in Terminal' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tell the leaders about at-target' })).not.toBeInTheDocument();
});
