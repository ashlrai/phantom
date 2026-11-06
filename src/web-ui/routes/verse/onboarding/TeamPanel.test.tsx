import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamPanel } from './TeamPanel.js';

vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: () => 'test', getReadClientProof: () => 'test', reportSessionExpired: vi.fn() }));
const view = { v: 1, team: 'default', members: [{ id: 'human:octocat', kind: 'human', role: 'owner', online: true, lastSeen: 'today' }], repos: [], claims: [], openHandoffs: [], pendingApprovals: [], messages: [], next: 'Ready.' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(view))));
describe('TeamPanel', () => {
  it('shows members, summary and a disabled empty invite', async () => {
    render(<TeamPanel />);
    expect(await screen.findByText('octocat')).toBeTruthy();
    expect(screen.getByText(/1 members, 1 online · 0 open handoffs · 0 approvals waiting/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('hides the invite when the endpoint is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({}, 404));
    render(<TeamPanel />);
    expect(await screen.findByText(/Team view needs Phantom 3.30/)).toBeTruthy();
    expect(screen.queryByLabelText('Invite a teammate')).toBeNull();
  });
  it('shows the invite and join instructions after success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply(view)).mockResolvedValueOnce(reply({ v: 1, team: 'default', member: 'human:octocat', invite: 'phm-invite-v1.fake', grants: 'membership-only', next: 'Ready.' }, 201));
    render(<TeamPanel />);
    fireEvent.change(await screen.findByLabelText('Invite a teammate'), { target: { value: 'octocat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(screen.getByText('phm-invite-v1.fake')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Copy invite/ })).toBeTruthy();
    expect(screen.getByText(/phm team join <invite>/)).toBeTruthy();
  });
});
