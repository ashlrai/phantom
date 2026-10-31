import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { resetWorkerLogSelection } from '../fleet-job-log/worker-log-selection.js';
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

const fixture = () => Response.json({
  mergesLastHour: { count: 3, items: [
    { repo: 'example/repo', number: 7, title: 'bridge: RQ-PHX-JOBONE' },
    { repo: 'example/repo', number: 8, title: 'chore: bump deps' },
    { repo: 'example/repo', number: 9, title: 'docs: tidy readme' },
  ] },
  publishesLastHour: [
    { job: 'RQ-PHX-JOBONE', lane: 'codex-personal', at: '2026-10-31T11:48:00Z', url: 'https://github.com/example/repo/pull/7' },
    { job: 'RQ-PHX-HIDDEN', lane: 'devin-review', at: '2026-10-31T11:30:00Z', url: 'https://github.com/example/repo/pull/8' },
  ],
  lanes: [], sources: { merges: 'healthy' },
});

beforeEach(() => {
  evictAll();
  resetWorkerLogSelection();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => fixture()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  evictAll();
  resetWorkerLogSelection();
});

const mergedRows = async () => {
  const list = await screen.findByRole('list', { name: 'Merged PRs' });
  return within(list).getAllByRole('listitem');
};

it('shows the lane and relative time when a publish matches the merge', async () => {
  render(<FleetMergesPane {...props} />);
  const row = (await mergedRows()).find(item => item.textContent?.includes('#7'));
  expect(row).toHaveTextContent('codex-personal');
  expect(row).toHaveTextContent('12m ago');
  const time = row?.querySelector('time');
  expect(time).toHaveAttribute('dateTime', '2026-10-31T11:48:00Z');
  expect(time?.getAttribute('title')).toBeTruthy();
});

it('shows an em dash and "time unknown" when no publish matches the merge', async () => {
  render(<FleetMergesPane {...props} />);
  const row = (await mergedRows()).find(item => item.textContent?.includes('#9'));
  expect(row).toHaveTextContent('· — · time unknown');
  expect(row?.querySelector('time')).not.toBeInTheDocument();
  expect(row?.querySelector('code')).not.toBeInTheDocument();
});

it('names the job in a code element once when the title has no RQ id', async () => {
  render(<FleetMergesPane {...props} />);
  const row = (await mergedRows()).find(item => item.textContent?.includes('#8'));
  const code = row?.querySelector('code');
  expect(code).toHaveTextContent('RQ-PHX-HIDDEN');
  expect(row?.querySelectorAll('code')).toHaveLength(1);
  expect(within(row as HTMLElement).getAllByText('RQ-PHX-HIDDEN')).toHaveLength(1);
  expect(row).toHaveTextContent('devin-review');
  expect(row).toHaveTextContent('30m ago');
});

it('does not repeat the job id already rendered by the title', async () => {
  render(<FleetMergesPane {...props} />);
  const row = (await mergedRows()).find(item => item.textContent?.includes('#7')) as HTMLElement;
  expect(within(row).getAllByText('RQ-PHX-JOBONE')).toHaveLength(1);
  expect(within(row).getByRole('button', { name: 'Open log for RQ-PHX-JOBONE' })).toBeInTheDocument();
  expect(row.querySelector('code')).not.toBeInTheDocument();
});
