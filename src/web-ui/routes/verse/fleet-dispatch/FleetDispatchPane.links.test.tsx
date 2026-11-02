import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens Lanes from a lane name and still pastes the terminal action', async () => {
  const runs = fleetRunsFixture();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ claudeLane: 'down — token rejected', lanes: [...runs.lanes, { ...runs.lanes[0]!, lane: 'claude' }] }))));
  const openPane = vi.fn();
  const openTerminal = vi.fn();
  const props = { visible: true, roots: ['/workspace'], host: { openPane, openTerminal } } as unknown as PaneProps;
  render(<FleetDispatchPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open codex-personal in Lanes' }));
  expect(openPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
  fireEvent.click(screen.getByRole('button', { name: 'Paste in Terminal' }));
  expect(openTerminal).toHaveBeenCalledExactlyOnceWith({ root: '/workspace', paste: '~/.ashlr-runs/bin/fix-claude-lane.sh' });
});
