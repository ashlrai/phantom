import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDecisionsPane } from './FleetDecisionsPane.js';
import { fixture } from './fixtures.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));
beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens the interject dialog with the repeated skip order', async () => {
  const data = fixture(), base = data.decisions[2];
  data.decisions = [1, 2, 3, 4].map(hour => ({ ...base, title: 'Example bet', at: `2026-10-31T0${hour}:00:00Z` }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetDecisionsPane {...{ visible: true } as PaneProps} />);
  const section = within(await screen.findByRole('region', { name: 'Repeated skips' }));
  fireEvent.click(section.getByRole('button', { name: 'Steer bet Example bet' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: "Bet 'Example bet' has been skipped 4 ticks in a row since 2026-10-31T01:00:00Z: No seat. Drop it or unblock it." });
});

it('opens the interject dialog with the hold order', async () => {
  const data = fixture(); data.held[0].holdKind = 'drip';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetDecisionsPane {...{ visible: true } as PaneProps} />);
  const list = within(await screen.findByRole('list', { name: 'Held items' }));
  fireEvent.click(list.getByRole('button', { name: 'Steer bet Held task' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: "Bet 'Held task' (ashlrai/phantom) is held (drip): Waiting. Next eligible 2099-01-01T00:00:00Z. Keep the hold or release it." });
});
