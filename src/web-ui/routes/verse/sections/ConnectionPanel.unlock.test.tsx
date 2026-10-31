import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConnectionPanel } from './ConnectionPanel.js';

const mocks = vi.hoisted(() => ({
  hasHold: false,
  setToken: vi.fn(),
  clearToken: vi.fn(),
  show: vi.fn(),
}));

vi.mock('../../../data/hooks.js', () => ({
  useAuthPhase: () => 'authenticated',
  useMutationHold: () => ({ hasHold: mocks.hasHold, heldUntil: mocks.hasHold ? Date.now() + 1_200_000 : null, setToken: mocks.setToken }),
}));
vi.mock('../../../data/auth-store.js', () => ({ clearMutationToken: mocks.clearToken, clearReadSession: vi.fn() }));
vi.mock('../../../components/primitives/Toast.js', () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock('./FleetSourcesRows.js', () => ({ FleetSourcesRows: () => null }));
vi.mock('./PairedDevicesRows.js', () => ({ PairedDevicesRows: () => null }));

beforeEach(() => {
  mocks.hasHold = false;
  vi.clearAllMocks();
});

it('opens the unlock dialog when the mutation hold is locked', () => {
  render(<ConnectionPanel />);
  expect(screen.queryByRole('button', { name: 'Lock now' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Unlock…' }));
  expect(screen.getByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
  expect(screen.getByText(/Actions from this console \(fleet switches, lane targets, Update now\)/)).toBeInTheDocument();
});

it('passes a fake token to the dialog hold and confirms unlocking', () => {
  render(<ConnectionPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Unlock…' }));
  const fakeToken = 'a'.repeat(64);
  fireEvent.change(screen.getByLabelText('Mutation token'), { target: { value: fakeToken } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(mocks.setToken).toHaveBeenCalledWith(fakeToken);
  expect(mocks.show).toHaveBeenCalledWith('Unlocked for 20 minutes.');
  expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).not.toBeInTheDocument();
});

it('shows the existing lock action while a hold is active', () => {
  mocks.hasHold = true;
  render(<ConnectionPanel />);
  expect(screen.queryByRole('button', { name: 'Unlock…' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
  expect(mocks.clearToken).toHaveBeenCalledOnce();
  expect(mocks.show).toHaveBeenCalledWith('Mutation hold cleared.');
});
