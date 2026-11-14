import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EcosystemWizard } from './EcosystemWizard.js';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), token: vi.fn() }));
vi.mock('../../../data/client.js', () => ({ apiGet: client.get, apiPost: client.post }));
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: client.token }));
const plan = {
  schemaVersion: 1, planId: 'a'.repeat(64), phase: 'preview',
  capabilities: [
    { id: 'vault', label: 'Phantom Secrets', state: 'locked', names: [], selected: true, next: 'Unlock the existing vault in a trusted terminal.' },
    { id: 'lexicon', label: 'Lexicon', state: 'detected', names: ['Example'], selected: true, next: null },
    { id: 'plugin', label: 'Ashlr plugin', state: 'missing', names: [], selected: false, next: null },
  ],
};
beforeEach(() => {
  client.get.mockReset().mockResolvedValue(plan);
  client.post.mockReset().mockResolvedValue({ phase: 'complete', results: [{ id: 'lexicon', status: 'configured', detail: 'Seeded.', next: null }] });
  client.token.mockReset().mockReturnValue('fixture-mutation-token');
});
afterEach(cleanup);

describe('ecosystem wizard', () => {
  it('detects, shows locked-vault guidance and grants exactly the toggled bundle once', async () => {
    render(<EcosystemWizard />);
    expect(screen.getByRole('status')).toHaveTextContent('Detecting');
    await screen.findByLabelText('Phantom Secrets: locked');
    expect(screen.getByText(/Unlock the existing vault/)).toBeInTheDocument();
    expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Phantom Secrets: locked'));
    fireEvent.click(screen.getByLabelText('Ashlr plugin: missing'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant 2 capabilities' }));
    expect(await screen.findByText('lexicon: configured')).toBeInTheDocument();
    expect(client.post).toHaveBeenCalledExactlyOnceWith('/api/onboard/ecosystem/grant', { planId: plan.planId, selected: ['lexicon', 'plugin'] }, 'fixture-mutation-token');
    expect(screen.queryByRole('button', { name: /Grant/ })).not.toBeInTheDocument();
  });

  it('disables an empty selection and disables toggles during wiring', async () => {
    let finish!: (value: unknown) => void;
    client.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<EcosystemWizard />);
    await screen.findByLabelText('Phantom Secrets: locked');
    fireEvent.click(screen.getByLabelText('Phantom Secrets: locked'));
    fireEvent.click(screen.getByLabelText('Lexicon: detected'));
    expect(screen.getByRole('button', { name: 'Grant 0 capabilities' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Lexicon: detected'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant 1 capabilities' }));
    expect(screen.getByLabelText('Lexicon: detected')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connecting...' })).toBeDisabled();
    finish({ phase: 'incomplete', results: [{ id: 'lexicon', status: 'needs-you', detail: 'Missing CLI.', next: 'Install Lexicon.' }] });
    expect(await screen.findByText('Install Lexicon.')).toBeInTheDocument();
    expect(screen.getByText('Some capabilities need a next step.')).toBeInTheDocument();
  });

  it('requires a mutation token and recovers with a new detection after a stale-plan refusal', async () => {
    client.token.mockReturnValueOnce(null);
    render(<EcosystemWizard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant 2 capabilities' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Detect again' }));
    client.post.mockRejectedValueOnce(new Error('private-diagnostic-must-stay-hidden'));
    fireEvent.click(await screen.findByRole('button', { name: 'Grant 2 capabilities' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private-diagnostic');
    fireEvent.click(screen.getByRole('button', { name: 'Detect again' }));
    await screen.findByRole('button', { name: 'Grant 2 capabilities' });
    expect(client.get).toHaveBeenCalledTimes(3);
  });

  it('aborts detection when unmounted and does not grant on a failed detection', async () => {
    client.get.mockRejectedValueOnce(new Error('unavailable'));
    const first = render(<EcosystemWizard />);
    await screen.findByRole('alert');
    expect(client.post).not.toHaveBeenCalled();
    first.unmount();
    expect(client.get.mock.calls[0]![1].aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Grant/ })).not.toBeInTheDocument());
  });
});
