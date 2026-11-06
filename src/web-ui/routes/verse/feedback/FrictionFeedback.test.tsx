import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FrictionFeedback } from './FrictionFeedback.js';
import { apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';

vi.mock('../../../data/client.js', () => ({ apiPost: vi.fn() }));
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn() }));
// Load the modal dependency outside timed interactions, as it is a lazy chunk.
beforeAll(async () => { await import('../../../components/primitives/Dialog.js'); });
beforeEach(() => {
  vi.mocked(getMutationToken).mockReturnValue('test-mutation-proof');
  vi.mocked(apiPost).mockResolvedValue({ id: 'RQ-test' });
});

async function fillFlag() {
  const user = userEvent.setup();
  render(<FrictionFeedback surface="chat" />);
  await user.click(screen.getByRole('button', { name: 'Flag UI friction' }));
  await user.click(await screen.findByRole('textbox'));
  await user.paste('The composer loses focus');
  return user;
}

it('submits only user text and surface and acknowledges successful persistence', async () => {
  const user = await fillFlag();
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(apiPost).toHaveBeenCalledWith('/api/verse/feedback',
    { description: 'The composer loses focus', surface: 'chat' }, 'test-mutation-proof');
  expect(await screen.findByRole('status')).toHaveTextContent('Flag saved');
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('retains the draft and permits retry on a failed write', async () => {
  vi.mocked(apiPost).mockRejectedValueOnce(new Error('Could not save locally'));
  const user = await fillFlag();
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
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Authorize console mutations');
  expect(apiPost).not.toHaveBeenCalled();
  await user.clear(screen.getByRole('textbox'));
  await user.type(screen.getByRole('textbox'), '   ');
  expect(screen.getByRole('button', { name: 'Save flag' })).toBeDisabled();
});

it('prevents another submission or dismissal while saving', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(apiPost).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const user = await fillFlag();
  await user.click(screen.getByRole('button', { name: 'Save flag' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(apiPost).toHaveBeenCalledTimes(1);
  finish({ id: 'RQ-test' });
  expect(await screen.findByRole('status')).toHaveTextContent('Flag saved');
});
