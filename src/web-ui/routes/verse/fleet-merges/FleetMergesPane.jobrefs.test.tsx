import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import * as workerLogSelection from '../fleet-job-log/worker-log-selection.js';
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

beforeEach(() => {
  evictAll();
  workerLogSelection.resetWorkerLogSelection();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    mergesLastHour: { count: 2, items: [
      { repo: 'ashlrai/phantom', number: 12, title: 'bridge: RQ-PHX-EXAMPLE1' },
      { repo: 'ashlrai/phantom', number: 13, title: 'Fix (#77)' },
    ] },
    publishesLastHour: [], lanes: [], sources: { merges: 'healthy' },
  })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  evictAll();
  workerLogSelection.resetWorkerLogSelection();
});

it('opens a merged job log and links pull request references in titles', async () => {
  const requestLog = vi.spyOn(workerLogSelection, 'requestWorkerLogJob');
  render(<FleetMergesPane {...props} />);
  const merged = within(await screen.findByRole('list', { name: 'Merged PRs' }));
  fireEvent.click(merged.getByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE1' }));
  expect(requestLog).toHaveBeenCalledWith('RQ-PHX-EXAMPLE1');
  expect(workerLogSelection.takeRequestedWorkerLogJob()).toBe('RQ-PHX-EXAMPLE1');
  expect(host.openPane).toHaveBeenCalledWith('worker-log');
  expect(merged.getByRole('link', { name: '#77' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/77');
});
