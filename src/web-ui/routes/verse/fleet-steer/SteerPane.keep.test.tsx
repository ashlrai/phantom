import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PaneProps } from '../panes/pane-registry.js';
import { SteerPane } from './SteerPane.js';
import { postWbSteerAction } from './steer-action.js';

vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ data: { roster: null, fleetState: 'ok', queueState: 'ok', seatsState: 'ok', queue: [] }, status: 'success' }),
  useRefetch: () => vi.fn(),
}));
vi.mock('../shell/section-visibility.js', () => ({ usePollWhileVisible: vi.fn() }));
vi.mock('./steer-action.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./steer-action.js')>()),
  postWbSteerAction: vi.fn(),
}));

const props = { visible: true } as PaneProps;
const note = () => screen.getByRole('textbox', { name: 'Steer note' });
const typeNote = () => fireEvent.change(note(), { target: { value: 'Please keep this note' } });

beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });
afterEach(() => { cleanup(); localStorage.clear(); });

it('restores an unsent note after unmount and hides the hint on edit', () => {
  const view = render(<SteerPane {...props} />);
  typeNote();
  view.unmount();
  render(<SteerPane {...props} />);
  expect(note()).toHaveValue('Please keep this note');
  expect(screen.getByText('Restored your unsent note.')).toBeInTheDocument();
  fireEvent.change(note(), { target: { value: 'Edited note' } });
  expect(screen.queryByText('Restored your unsent note.')).not.toBeInTheDocument();
});

it('clears a successfully sent note before remount', async () => {
  vi.mocked(postWbSteerAction).mockResolvedValue({ dryRun: false });
  const view = render(<SteerPane {...props} />);
  typeNote();
  fireEvent.click(screen.getByRole('button', { name: 'Send note' }));
  await waitFor(() => expect(note()).toHaveValue(''));
  view.unmount();
  render(<SteerPane {...props} />);
  expect(note()).toHaveValue('');
});

it('keeps a rejected note after remount', async () => {
  vi.mocked(postWbSteerAction).mockRejectedValue(new Error('Send failed'));
  const view = render(<SteerPane {...props} />);
  typeNote();
  fireEvent.click(screen.getByRole('button', { name: 'Send note' }));
  await screen.findByText('Send failed');
  view.unmount();
  render(<SteerPane {...props} />);
  expect(note()).toHaveValue('Please keep this note');
  expect(screen.getByText('Restored your unsent note.')).toBeInTheDocument();
});
