import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetEventsPane } from './FleetEventsPane.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens job logs through the pane host and links PRs to GitHub', async () => {
  const openPane = vi.fn();
  const props = { visible: true, host: { openPane } } as unknown as PaneProps;
  const fetcher = vi.fn(async () => Response.json({
    events: [
      { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'launched RQ-PHX-FOO codex-personal pid 1' },
      { at: '2026-01-02T00:00:00Z', kind: 'merge', text: 'merged ashlrai/phantom #1719 bridge' },
    ],
    sources: { runsDir: 'healthy' },
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetEventsPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open log for RQ-PHX-FOO' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(screen.getByRole('link', { name: '#1719' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1719');
  expect(fetcher).toHaveBeenCalledWith('/api/verse/fleet/runs', expect.anything());
});
