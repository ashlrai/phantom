import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { CommsLimitsView } from '../../../../core/comms/comms-confirm.js';
import { COMMS_CONFIRM_PATH, CommsConfirmCard } from './CommsConfirmCard.js';

vi.mock('../../../data/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(), apiPost: vi.fn(),
}));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const unconfirmed: CommsLimitsView = {
  state: 'unconfirmed',
  digest: DIGEST,
  confirmedAt: null,
  limits: {
    team: [{ channel: 'imessage', id: 'imessage:0123456789abcdef' }],
    channels: ['imessage'],
    settings: [{ key: 'limits.maxPerDay', value: '3' }],
  },
};

beforeEach(() => {
  setMutationToken('fake-token');
  vi.mocked(apiGet).mockResolvedValue(unconfirmed as never);
});
afterEach(() => {
  clearMutationToken();
  vi.clearAllMocks();
});

it('lists the limits in plain words', async () => {
  render(<CommsConfirmCard />);
  expect(await screen.findByRole('heading', { name: 'Confirm Comms limits' })).toBeTruthy();
  expect(screen.getByText('imessage: imessage:0123456789abcdef')).toBeTruthy();
  expect(screen.getByText('limits.maxPerDay = 3')).toBeTruthy();
  expect(apiGet).toHaveBeenCalledWith(COMMS_CONFIRM_PATH, expect.anything());
});

it('disables the button while posting, then shows the confirmed state with its time', async () => {
  let finish: (view: CommsLimitsView) => void = () => {};
  vi.mocked(apiPost).mockReturnValue(new Promise(resolve => { finish = resolve as typeof finish; }) as never);
  render(<CommsConfirmCard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm these limits' }));
  const busy = await screen.findByRole('button', { name: 'Confirming…' });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  expect(apiPost).toHaveBeenCalledWith(COMMS_CONFIRM_PATH, { limitsDigest: DIGEST }, 'fake-token');
  finish({ ...unconfirmed, state: 'confirmed', confirmedAt: '2026-11-09T12:00:00.000Z' });
  expect((await screen.findByRole('status')).textContent).toContain(`Confirmed at ${new Date('2026-11-09T12:00:00.000Z').toLocaleString()}`);
  expect(screen.queryByRole('button', { name: 'Confirm these limits' })).toBeNull();
});

it('cannot confirm without the mutation hold', async () => {
  clearMutationToken();
  render(<CommsConfirmCard />);
  const button = await screen.findByRole('button', { name: 'Confirm these limits' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Unlock to confirm')).toBeTruthy();
});

it('renders nothing once confirmed or when comms.toml is unknown', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce({ ...unconfirmed, state: 'confirmed' } as never);
  const { container, unmount } = render(<CommsConfirmCard />);
  await vi.waitFor(() => expect(apiGet).toHaveBeenCalled());
  expect(container.textContent).toBe('');
  unmount();
  vi.mocked(apiGet).mockResolvedValueOnce({ state: 'unknown', limits: null, digest: null, confirmedAt: null } as never);
  const second = render(<CommsConfirmCard />);
  await vi.waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  expect(second.container.textContent).toBe('');
});
