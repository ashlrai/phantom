import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';
import { requestInboxChannel, takeRequestedInboxChannel } from './inbox-source-request.js';

const entries = [
  { at: '2026-01-01 10:00', source: 'Telegram', text: 'fake telegram one' },
  { at: '2026-01-01 10:01', source: 'tg bot', text: 'fake telegram two' },
  { at: '2026-01-01 10:02', source: 'desktop app', text: 'fake desktop' },
  { at: '2026-01-01 10:03', source: 'unknown source', text: 'fake other' },
];
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (def: { key: string }) => def.key === 'verse-fleet-runs-inbox-100'
    ? { data: { v: 1, sourceState: 'healthy', entries }, status: 'success' }
    : { data: undefined, status: 'success' },
  useRefetch: () => vi.fn(),
}));
const props = { visible: true, host: { addToMessage: vi.fn() } } as unknown as PaneProps;
afterEach(() => { cleanup(); takeRequestedInboxChannel(); });

it('consumes a request on mount, groups raw sources, and clears to all', () => {
  requestInboxChannel('telegram');
  render(<FleetInboxPane {...props} />);
  expect(takeRequestedInboxChannel()).toBeNull();
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.getByText('fake telegram one')).toBeInTheDocument();
  expect(screen.getByText('fake telegram two')).toBeInTheDocument();
  expect(screen.queryByText('fake desktop')).not.toBeInTheDocument();
  expect(screen.getByText(/Filtered to Telegram/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.getAllByRole('article')).toHaveLength(4);
  expect(screen.queryByText(/Filtered to/)).not.toBeInTheDocument();
});

it('handles requests while mounted and lets raw source buttons replace them', () => {
  render(<FleetInboxPane {...props} />);
  expect(screen.getAllByRole('article')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'desktop app' }));
  act(() => requestInboxChannel('other'));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('fake other')).toBeInTheDocument();
  expect(screen.getByText(/Filtered to Other/)).toBeInTheDocument();
  act(() => requestInboxChannel('telegram'));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'desktop app' }));
  expect(screen.getByText('fake desktop')).toBeInTheDocument();
  expect(screen.queryByText(/Filtered to/)).not.toBeInTheDocument();
});
