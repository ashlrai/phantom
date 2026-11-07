import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { NO_FLEET_TEXT } from '../fleet/no-fleet.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';

const props = { visible: true, roots: [], host: { openTerminal: vi.fn() } } as unknown as PaneProps;
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['missing', 'degraded', 'healthy'] as const)('shows the appropriate notice for a %s runs directory', async (state) => {
  const fixture = fleetRunsFixture({ claudeLane: null });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture, sources: { ...fixture.sources, runsDir: state } })));
  render(<FleetDispatchPane {...props} />);
  await screen.findByRole('list', { name: 'Lane verdicts' });
  expect(screen.queryByText(NO_FLEET_TEXT)).toBe(state === 'missing' ? screen.getByRole('status') : null);
  expect(screen.queryByText('Dispatch data may be incomplete.')).toBe(state === 'degraded' ? screen.getByRole('status') : null);
});
