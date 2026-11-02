import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens Lanes from a lane name', async () => {
  const now = Date.now();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
    samples: [{ at: new Date(now).toISOString(), workers: 1, leaders: 1, paused: false, lanes: [{ lane: 'codex-personal', running: 1, target: 2, queued: 0, held: false }] }],
  })));
  const openPane = vi.fn();
  const props = { visible: true, host: { openPane } } as unknown as PaneProps;
  render(<FleetCapacityPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open codex-personal in Lanes' }));
  expect(openPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
});
