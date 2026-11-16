import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamInviteAccept } from './TeamInviteAccept.js';
const mocks = vi.hoisted(() => ({ post: vi.fn(), getToken: vi.fn(), touch: vi.fn() }));
vi.mock('../data/client.js', () => ({ apiPost: mocks.post }));
vi.mock('../data/auth-store.js', () => ({ getMutationToken: mocks.getToken, touchMutationHold: mocks.touch }));
vi.mock('../components/auth/MutationTokenDialog.js', () => ({ MutationTokenDialog: () => null }));
const invite = 'a'.repeat(64);
function mount(query = `?invite=${invite}`) {
  render(<MemoryRouter initialEntries={[`/teams/core/accept${query}`]}><Routes><Route path="/teams/:team/accept" element={<TeamInviteAccept />} /></Routes></MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.getToken.mockReturnValue('mutation'); mocks.post.mockResolvedValue({}); });
describe('team invitation acceptance screen', () => {
  it('requires an explicit click and confirms successful membership', async () => {
    mount(); expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await screen.findByText('You joined core.');
    expect(mocks.post).toHaveBeenCalledWith('/api/teams/core/invites/accept', { token: invite }, 'mutation');
    expect(mocks.touch).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });
  it('disables malformed links and requires mutation authority', async () => {
    mount(''); expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('invalid');
  });
  it('keeps invite authority distinct from mutation authority', () => {
    mocks.getToken.mockReturnValue(null); mount();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Unlock mutations');
  });
  it('shows redemption errors and prevents clicks while the request is pending', async () => {
    let reject!: (reason: Error) => void;
    mocks.post.mockReturnValue(new Promise((_, fail) => { reject = fail; })); mount();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(screen.getByRole('button', { name: 'Joining…' })).toBeDisabled();
    await act(async () => { reject(new Error('expired')); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('expired'));
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
  });
});
