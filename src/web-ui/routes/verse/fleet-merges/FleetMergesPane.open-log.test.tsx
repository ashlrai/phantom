import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

const host = {
  sendToChat: vi.fn(), addToMessage: vi.fn(), openPane: vi.fn(), closePane: vi.fn(),
  openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn(),
};
const props: PaneProps = {
  paneId: 'fleet-merges', sessionId: null, session: null, roots: [], events: [], turnFiles: [],
  visible: true, presentation: 'column', requests: { terminal: null, preview: null, diff: null }, host,
};

beforeEach(() => { evictAll(); resetWorkerLogSelection(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); resetWorkerLogSelection(); });

it('opens the selected publish log and excludes invalid job IDs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    mergesLastHour: { count: 0, items: [] },
    publishesLastHour: [
      { job: 'RQ-PHX-EXAMPLE1', lane: 'codex', at: '2026-01-02T00:00:00Z' },
      { job: '../bad', lane: 'codex', at: '2026-01-01T00:00:00Z' },
    ],
    lanes: [], sources: { merges: 'healthy' },
  })));
  render(<FleetMergesPane {...props} />);
  const list = await screen.findByRole('list', { name: 'Publishes waiting' });
  const rows = within(list).getAllByRole('listitem');
  const button = within(rows[0]).getByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE1' });
  expect(button).toHaveTextContent('Open log');
  expect(within(rows[1]).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(host.openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-EXAMPLE1');
});
