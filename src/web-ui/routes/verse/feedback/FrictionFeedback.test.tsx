import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FrictionFeedback } from './FrictionFeedback.js';
import { apiGetWithMutationToken, apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';

vi.mock('../../../data/client.js', () => ({ apiGetWithMutationToken: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn() }));
// Load the modal dependency outside timed interactions, as it is a lazy chunk.
beforeAll(async () => { await import('../../../components/primitives/Dialog.js'); });
beforeEach(() => {
  vi.mocked(getMutationToken).mockReturnValue('test-mutation-proof');
  vi.mocked(apiGetWithMutationToken).mockResolvedValue({ requests: [] });
  vi.mocked(apiPost).mockResolvedValue({ status: 'queued', jobId: 'RQ-PHX-UIREQABCDEF123456' });
});

async function fillFlag() {
  const user = userEvent.setup();
  render(<FrictionFeedback surface="chat" />);
  await user.click(screen.getByRole('button', { name: 'Improve this screen' }));
  await user.click(await screen.findByRole('textbox'));
  await user.paste('The composer loses focus');
  return user;
}

it('defaults to Build it and queues a pull-request request', async () => {
  const user = await fillFlag();
  expect(screen.getByRole('radio', { name: 'Build it' })).toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Send to agent' }));
  expect(apiPost).toHaveBeenCalledWith('/api/verse/change-request',
    { description: 'The composer loses focus', surface: 'chat' }, 'test-mutation-proof');
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Queued for an agent as RQ-PHX-UIREQABCDEF123456; it will open a pull request.',
  );
});

it('Just flag it submits only user text and surface and acknowledges persistence', async () => {
  const user = await fillFlag();
  await user.click(screen.getByRole('radio', { name: 'Just flag it' }));
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(apiPost).toHaveBeenCalledWith('/api/verse/feedback',
    { description: 'The composer loses focus', surface: 'chat' }, 'test-mutation-proof');
  expect(await screen.findByRole('status')).toHaveTextContent('Flag saved');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('retains the draft and permits retry on a failed write', async () => {
  vi.mocked(apiPost).mockRejectedValueOnce(new Error('Could not save locally'));
  const user = await fillFlag();
  await user.click(screen.getByRole('radio', { name: 'Just flag it' }));
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save locally');
  expect(screen.getByRole('textbox')).toHaveValue('The composer loses focus');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Flag saved');
});

it('requires authorization and keeps empty flags disabled', async () => {
  vi.mocked(getMutationToken).mockReturnValue(null);
  const user = await fillFlag();
  await user.click(screen.getByRole('button', { name: 'Send to agent' }));
  expect(await screen.findByText('Authorize console mutations before submitting a change request.')).toHaveAttribute('role', 'alert');
  expect(apiPost).not.toHaveBeenCalled();
  await user.clear(screen.getByRole('textbox'));
  await user.type(screen.getByRole('textbox'), '   ');
  expect(screen.getByRole('button', { name: 'Send to agent' })).toBeDisabled();
});

it('prevents another submission or dismissal while saving', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(apiPost).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const user = await fillFlag();
  await user.click(screen.getByRole('radio', { name: 'Just flag it' }));
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(apiPost).toHaveBeenCalledTimes(1);
  finish({ id: 'RQ-test' });
  expect(await screen.findByRole('status')).toHaveTextContent('Flag saved');
});

it('renders and opens a known pull-request link', async () => {
  vi.mocked(apiGetWithMutationToken).mockResolvedValue({
    requests: [{
      jobId: 'RQ-PHX-UIREQABCDEF123456', surface: 'chat', createdAt: '2026-11-25T10:59:00.000Z',
      ageSeconds: 60, status: 'queued', fate: null,
      pr: { url: 'https://github.com/ashlrai/phantom/pull/42', state: 'merged' },
    }],
  });
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(<FrictionFeedback surface="chat" />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Improve this screen' }));
  const link = await screen.findByRole('link', { name: 'Open pull request' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  await userEvent.setup().click(link);
  expect(open).toHaveBeenCalledWith('https://github.com/ashlrai/phantom/pull/42', '_blank', 'noopener,noreferrer');
  expect(screen.getByText('1m ago')).toBeInTheDocument();
  expect(screen.getByText('merged')).toBeInTheDocument();
  open.mockRestore();
});

it('keeps a link with unknown state and hides unsafe links', async () => {
  vi.mocked(apiGetWithMutationToken).mockResolvedValue({
    requests: [
      { jobId: 'RQ-PHX-UIREQABCDEF123456', surface: 'chat', ageSeconds: 60, status: 'queued',
        fate: null, pr: { url: 'https://github.com/ashlrai/phantom/pull/42', state: null } },
      { jobId: 'RQ-PHX-UIREQABCDEF123457', surface: 'fleet', ageSeconds: 0, status: 'queued',
        fate: null, pr: { url: 'https://example.com/unsafe', state: 'open' } },
    ],
  });
  render(<FrictionFeedback surface="chat" />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Improve this screen' }));
  const links = await screen.findAllByRole('link', { name: 'Open pull request' });
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  expect(screen.queryByText(/^(open|closed|merged)$/)).not.toBeInTheDocument();
});
