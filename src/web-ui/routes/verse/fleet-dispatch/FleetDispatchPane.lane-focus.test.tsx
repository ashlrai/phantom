import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { resetLaneFocus, subscribeLaneFocus, takeRequestedLane } from '../fleet-lanes/lane-focus-request.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';

beforeEach(() => { evictAll(); resetLaneFocus(); });
afterEach(() => { cleanup(); resetLaneFocus(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('requests lane focus before opening the Lanes pane', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ claudeLane: null }))));
  const order: string[] = [];
  const unsubscribe = subscribeLaneFocus(() => order.push('focus'));
  const openPane = vi.fn(() => { order.push('pane'); });
  const props = { visible: true, roots: ['/workspace'], host: { openPane, openTerminal: vi.fn() } } as unknown as PaneProps;
  render(<FleetDispatchPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open codex-personal in Lanes' }));
  expect(order).toEqual(['focus', 'pane']);
  expect(takeRequestedLane()).toBe('codex-personal');
  expect(openPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
  unsubscribe();
});
