/** RQ-PHX-RECHECKNOWBUTTON340 — the button posts once, shows the outcome, refetches on success. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { RecheckNowButton } from './RecheckNowButton.js';

const apiPost = vi.fn();
const refetch = vi.fn();
vi.mock('../../../data/client.js', async (orig) => ({ ...(await orig<typeof import('../../../data/client.js')>()), apiPost: (...a: unknown[]) => apiPost(...a) }));
vi.mock('../../../data/hooks.js', async (orig) => ({ ...(await orig<typeof import('../../../data/hooks.js')>()), useRefetch: () => refetch }));

beforeEach(() => { apiPost.mockReset(); refetch.mockReset(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); });

const press = () => fireEvent.click(screen.getByRole('button', { name: 'Recheck now' }));

it('shows the recorded verdict and refetches history and verdict once each', async () => {
  apiPost.mockResolvedValue({ recorded: { overall: 'VERIFIED', asOf: new Date().toISOString() } });
  render(<RecheckNowButton />);
  press();
  await waitFor(() => expect(screen.getByText(/^Recorded VERIFIED as of /)).toBeInTheDocument());
  expect(apiPost).toHaveBeenCalledTimes(1);
  expect(apiPost.mock.calls[0]!.slice(0, 2)).toEqual(['/api/verse/fleet/recheck/record', {}]);
  expect(refetch).toHaveBeenCalledTimes(2); // history + verdict (useRefetch is mocked to one shared fn)
});

it('shows the already-running line on 409 without refetching', async () => {
  apiPost.mockRejectedValue(new ApiError('conflict', 409, '/x'));
  render(<RecheckNowButton />);
  press();
  await waitFor(() => expect(screen.getByText('A recheck is already running')).toBeInTheDocument());
  expect(refetch).not.toHaveBeenCalled();
});

it('shows not-on-this-build on 404', async () => {
  apiPost.mockRejectedValue(new ApiError('nope', 404, '/x'));
  render(<RecheckNowButton />);
  press();
  await waitFor(() => expect(screen.getByText('Recheck now is not on this Phantom build')).toBeInTheDocument());
});

it('is disabled and relabelled while pending', async () => {
  let finish!: (v: unknown) => void;
  apiPost.mockReturnValue(new Promise((r) => { finish = r; }));
  render(<RecheckNowButton />);
  press();
  const busy = await screen.findByRole('button', { name: 'Rechecking…' });
  expect(busy).toBeDisabled();
  fireEvent.click(busy);
  expect(apiPost).toHaveBeenCalledTimes(1);
  finish({ recorded: { overall: 'UNKNOWN', asOf: new Date().toISOString() } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Recheck now' })).toBeEnabled());
});
